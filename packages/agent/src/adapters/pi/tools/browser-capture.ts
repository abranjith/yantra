/**
 * `browser_capture` tool spec (FEAT-058): a clean screenshot saved to the run
 * directory as a deliverable the user asked for.
 *
 * Unlike Vision Assist (`browser_screenshot`), the pixels never reach the
 * model provider: the result carries metadata only (paths, sizes, labels) and
 * no image content, so the middleware's image gate is never involved. That is
 * why it needs no `context.screenshots` grant and works with a text-only
 * model. It keeps every other protection: the sensitive-screen latch (checked
 * before anything is reserved), owner-only file modes written temp-then-rename,
 * its own capture budget with pixel and byte bounds, and an audit listing
 * through the generic artifact reference.
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DeliverableCaptureError,
  SetOfMarksError,
  StaleElementRefError,
  type AgentDeliverableCapture,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { BudgetDecision } from '../../../runtime/budget.js';
import {
  artifactRefsOfSet,
  type CaptureArtifactSet,
  type CapturePart,
} from '../../../runtime/capture-artifacts.js';
import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

const BrowserCaptureParams = Type.Object(
  {
    scope: Type.Union(
      [Type.Literal('viewport'), Type.Literal('full_page'), Type.Literal('element')],
      {
        description:
          'viewport = what is visible now; full_page = the whole scrollable page (tiled when ' +
          'tall); element = one element, given by ref.',
      },
    ),
    ref: Type.Optional(
      Type.String({
        pattern: '^e[1-9]\\d*$',
        description: 'The eNN ref of the element to capture; only with scope element.',
      }),
    ),
  },
  { additionalProperties: false },
);

type Params = Static<typeof BrowserCaptureParams>;

/** Build the local deliverable capture tool. */
export function browserCaptureSpec(
  services: RunServices,
): ToolWrapperSpec<typeof BrowserCaptureParams> {
  return {
    name: 'browser_capture',
    windDownExempt: (s, params) => s.progress.captureExemptionAvailable(params.scope),
    label: 'Browser Capture',
    description:
      'Save a clean screenshot of the page to the run directory as a deliverable the user ' +
      'asked for. The image is kept on this computer and is NOT shown to you; you receive its ' +
      'path and size. Capture after your last page action. Do not use it to inspect a page: ' +
      'read the page with browser_observe or browser_extract.',
    parameters: BrowserCaptureParams,
    sanitizationProfile: 'public',
    // A capture is local, cheap, bounded, and delivers a declared item, so it
    // stays callable during the exploration wind-down (S8). The hard deadline,
    // the per-tool timeout, and the capture budget still bind.
    run: (params): Promise<DomainResult> => runCapture(params, services),
  };
}

async function runCapture(params: Params, services: RunServices): Promise<DomainResult> {
  if (params.scope === 'element' && params.ref === undefined) {
    return invalid('capture-ref-required');
  }
  if (params.scope !== 'element' && params.ref !== undefined) {
    return invalid('capture-ref-forbidden');
  }
  const deps = services.domain.browser;
  if (deps === null) return unavailable('no-browser');
  const controller = deps.controller;
  const latch = deps.sensitiveScreenLatch;
  if (latch === undefined || latch.isLatched(controller.topLevelDocumentEpoch?.() ?? null)) {
    return {
      ok: false,
      errorCode: 'SCREENSHOT_SENSITIVE_SCREEN',
      message: renderAgentMessage('tool', 'SCREENSHOT_SENSITIVE_SCREEN', 'secret-latched'),
      retryable: false,
      diagnostic: { cause: 'secret-latched' },
    };
  }

  const reserved = services.budgets.reserveDeliverableCapture();
  if (!reserved.isOk) return budgetFailure(reserved.error);
  const seq = reserved.value;

  let captured: AgentDeliverableCapture;
  try {
    captured = await controller.captureDeliverable({
      scope: params.scope,
      ...(params.ref === undefined ? {} : { ref: params.ref }),
      bounds: services.budgets.deliverableBounds(),
    });
  } catch (error) {
    return captureFailure(error);
  }

  const tiles = captured.tiles.map((tile) => ({ ...tile, bytes: Buffer.from(tile.png) }));
  if (tiles.length === 0 || tiles.some((tile) => !hasPngSignature(tile.bytes))) {
    return unavailable('capture-failed');
  }
  const accounted = services.budgets.accountDeliverableBytes(
    tiles.map((tile) => ({ width: tile.width, height: tile.height, bytes: tile.bytes.byteLength })),
  );
  if (!accounted.isOk) return budgetFailure(accounted.error);

  let parts: CapturePart[];
  try {
    parts = await writeParts(services.runDir, seq, tiles);
  } catch {
    // swallow-ok: the failure is reported as a typed CAPTURE_UNAVAILABLE result; writeParts already removed every file it wrote
    return unavailable('capture-failed');
  }

  const set: CaptureArtifactSet = {
    scope: captured.scope,
    ...(captured.ref === undefined ? {} : { ref: captured.ref }),
    parts,
    complete: captured.complete,
    labels: [...captured.labels],
    ...(captured.capturedHeight === undefined ? {} : { captured_height: captured.capturedHeight }),
    ...(captured.pageHeight === undefined ? {} : { page_height: captured.pageHeight }),
  };
  const bytes = parts.reduce((sum, part) => sum + part.bytes, 0);
  services.runHealth.recordDeliverableCapture({ files: parts.length, bytes });
  // One ledger entry per call, cited by part 1: fulfillment judges screenshot
  // items from it (FEAT-058 S6/S7), and the Brief lists its files.
  services.actionLedger.record({
    kind: 'capture',
    scope: set.scope,
    path: parts[0]!.path,
    sha256: parts[0]!.sha256,
    bytes,
    producer: 'browser_capture',
    parts: parts.length,
    complete: set.complete,
    captureSet: set,
  });
  return {
    ok: true,
    model: {
      scope: set.scope,
      ...(set.ref === undefined ? {} : { ref: set.ref }),
      complete: set.complete,
      labels: set.labels,
      parts: parts.map(({ path, width, height, bytes: size, part }) => ({
        path,
        width,
        height,
        bytes: size,
        part,
      })),
      ...(set.captured_height === undefined ? {} : { captured_height: set.captured_height }),
      ...(set.page_height === undefined ? {} : { page_height: set.page_height }),
      remaining_captures: services.budgets.remainingDeliverableCaptures(),
      saved_locally: true,
    },
    details: { artifacts: artifactRefsOfSet(set), capture_set: set },
  };
}

/**
 * Writes every tile as `screenshots/capture-<seq>-<sha12>[-p<i>].png` at mode
 * 0600 inside a 0700 directory, temp then rename. All or nothing: a failure
 * after some tiles were written removes those tiles, and any temp file is
 * removed in `finally`.
 */
async function writeParts(
  runDir: string,
  seq: number,
  tiles: readonly { readonly bytes: Buffer; readonly width: number; readonly height: number }[],
): Promise<CapturePart[]> {
  const dir = join(runDir, 'screenshots');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // swallow-ok: best-effort chmod; permissions are hardening only
  await chmod(dir, 0o700).catch(() => undefined);
  const written: string[] = [];
  const parts: CapturePart[] = [];
  try {
    for (const [index, tile] of tiles.entries()) {
      const sha256 = createHash('sha256').update(tile.bytes).digest('hex');
      const suffix = tiles.length > 1 ? `-p${index + 1}` : '';
      const relativePath = `screenshots/capture-${seq}-${sha256.slice(0, 12)}${suffix}.png`;
      const finalPath = join(runDir, ...relativePath.split('/'));
      const tempPath = `${finalPath}.tmp`;
      try {
        await writeFile(tempPath, tile.bytes, { mode: 0o600 });
        // swallow-ok: best-effort chmod; permissions are hardening only
        await chmod(tempPath, 0o600).catch(() => undefined);
        await rename(tempPath, finalPath);
        written.push(finalPath);
      } finally {
        // swallow-ok: best-effort unlink of a temp file that was renamed or never completed
        await unlink(tempPath).catch(() => undefined);
      }
      parts.push({
        path: relativePath,
        sha256,
        bytes: tile.bytes.byteLength,
        width: tile.width,
        height: tile.height,
        part: index + 1,
      });
    }
    return parts;
  } catch (error) {
    // swallow-ok: best-effort removal of this call's files so a set is all or nothing
    await Promise.all(written.map((path) => unlink(path).catch(() => undefined)));
    throw error;
  }
}

function captureFailure(error: unknown): DomainFailure {
  if (error instanceof StaleElementRefError) {
    return {
      ok: false,
      errorCode: 'STALE_ELEMENT_REF',
      message: error.message,
      retryable: true,
      diagnostic: { cause: 'stale-ref' },
    };
  }
  if (error instanceof DeliverableCaptureError) return unavailable(error.code);
  if (error instanceof SetOfMarksError && error.code === 'SET_OF_MARKS_EPOCH_CHANGED') {
    return unavailable('epoch-changed');
  }
  return unavailable('capture-failed');
}

type UnavailableCause =
  | 'no-browser'
  | 'capture-failed'
  | 'epoch-changed'
  | 'overlay-present'
  | 'bounds-exceeded';

function unavailable(cause: UnavailableCause): DomainFailure {
  return {
    ok: false,
    errorCode: 'CAPTURE_UNAVAILABLE',
    message: renderAgentMessage('tool', 'CAPTURE_UNAVAILABLE', cause),
    retryable: cause !== 'no-browser',
    diagnostic: { cause },
  };
}

function invalid(cause: 'capture-ref-required' | 'capture-ref-forbidden'): DomainFailure {
  return {
    ok: false,
    errorCode: 'INVALID_INPUT',
    message: renderAgentMessage('tool', 'INVALID_INPUT', cause),
    retryable: true,
    diagnostic: { cause },
  };
}

function budgetFailure(decision: BudgetDecision): DomainFailure {
  return {
    ok: false,
    errorCode: decision.code,
    message: decision.message,
    retryable: false,
    details: { budget_limit: decision.limit },
    diagnostic: { cause: decision.limit },
  };
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (byte, index) => bytes[index] === byte,
  );
}
