import { createHash } from 'node:crypto';
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SetOfMarksError, StaleElementRefError } from '@yantra/core';
import type { ArtifactRef } from '@yantra/protocol';
import { Type, type Static } from 'typebox';

import { idOf } from '../../../runtime/action-ledger.js';
import type { BudgetDecision } from '../../../runtime/budget.js';
import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import type { CaptureMetadata } from '../../../runtime/vision.js';

const BrowserScreenshotParams = Type.Object(
  {
    ref: Type.Optional(Type.String({ pattern: '^e[1-9]\\d*$' })),
  },
  { additionalProperties: false },
);

type Params = Static<typeof BrowserScreenshotParams>;

/** Build the explicitly requested fallback-evidence screenshot tool. */
export function browserScreenshotSpec(
  services: RunServices,
): ToolWrapperSpec<typeof BrowserScreenshotParams> {
  return {
    name: 'browser_screenshot',
    label: 'Browser Screenshot',
    description:
      'Capture fallback visual evidence when text observation is insufficient or contradicts observed behavior. Use only after reading text evidence; do not use it as the default way to inspect a page.',
    parameters: BrowserScreenshotParams,
    sanitizationProfile: 'public',
    run: (params, ctx): Promise<DomainResult> => runScreenshot(params, services, ctx.callId),
  };
}

async function runScreenshot(
  params: Params,
  services: RunServices,
  callId: string | null,
): Promise<DomainResult> {
  const deps = services.domain.browser;
  if (deps === null) return unavailable('No active browser is available for screenshot capture.');
  const controller = deps.controller;
  const latch = deps.sensitiveScreenLatch;
  if (latch === undefined || latch.isLatched(controller.topLevelDocumentEpoch?.() ?? null)) {
    return {
      ok: false,
      errorCode: 'SCREENSHOT_SENSITIVE_SCREEN',
      message: renderAgentMessage('tool', 'SCREENSHOT_SENSITIVE_SCREEN', 'secret-latched'),
      retryable: false,
    };
  }

  const reserved = services.budgets.reserveCapture();
  if (!reserved.isOk) return budgetFailure(reserved.error);

  let tempPath: string | undefined;
  try {
    const captured = await controller.capturePng(params.ref);
    const bytes = Buffer.from(captured.png);
    if (!hasPngSignature(bytes)) return unavailable('Chrome returned a non-PNG screenshot.');
    if (
      captured.width > 1600 ||
      captured.height > 1200 ||
      captured.width <= 0 ||
      captured.height <= 0
    ) {
      return budgetFailure({
        code: 'BUDGET_EXHAUSTED',
        limit: 'capture-pixels',
        message: 'The captured image exceeded the 1600 by 1200 pixel limit.',
        carriesPublishRemedy: false,
      });
    }
    if (bytes.byteLength > services.budgets.maxCaptureBytes) {
      return budgetFailure({
        code: 'BUDGET_EXHAUSTED',
        limit: 'capture-bytes',
        message: `The captured image exceeded the ${services.budgets.maxCaptureBytes} byte limit.`,
        carriesPublishRemedy: false,
      });
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const seq = services.budgets.snapshot().captureCount;
    const relativePath = `screenshots/${seq}-${sha256.slice(0, 12)}.png`;
    const screenshotsDir = join(services.runDir, 'screenshots');
    const finalPath = join(services.runDir, ...relativePath.split('/'));
    tempPath = `${finalPath}.tmp`;
    await mkdir(screenshotsDir, { recursive: true, mode: 0o700 });
    // swallow-ok: best-effort chmod; permissions are hardening only
    await chmod(screenshotsDir, 0o700).catch(() => undefined);
    await writeFile(tempPath, bytes, { mode: 0o600 });
    // swallow-ok: best-effort chmod; permissions are hardening only
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, finalPath);
    tempPath = undefined;

    const artifact: CaptureMetadata = {
      path: relativePath,
      sha256,
      mime_type: 'image/png',
      width: captured.width,
      height: captured.height,
      bytes: bytes.byteLength,
      scope: captured.scope,
      ...(captured.ref === undefined ? {} : { ref: captured.ref }),
      marks: captured.marks,
      seq,
    };
    // The generic artifact reference (FEAT-058 S9): this image is shown to the
    // model, so it is recorded as sent.
    const auditArtifact: ArtifactRef = {
      kind: 'screenshot',
      path: artifact.path,
      sha256: artifact.sha256,
      mime_type: artifact.mime_type,
      bytes: artifact.bytes,
      width: artifact.width,
      height: artifact.height,
      sent_to_model: true,
    };
    const action = idOf(
      services.actionLedger.record({
        callId,
        artifacts: [auditArtifact],
        kind: 'capture',
        scope: artifact.scope,
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        producer: 'browser_screenshot',
      }),
    );
    return {
      ok: true,
      model: { action, ...artifact, remaining_captures: services.budgets.remainingCaptures() },
      details: { artifacts: [auditArtifact], action_ids: [action] },
      content: [
        {
          kind: 'image',
          mimeType: 'image/png',
          base64: bytes.toString('base64'),
          artifact,
        },
      ],
    };
  } catch (error) {
    if (error instanceof StaleElementRefError) {
      return { ok: false, errorCode: 'STALE_ELEMENT_REF', message: error.message, retryable: true };
    }
    if (error instanceof SetOfMarksError) return unavailable(error.message);
    return unavailable('Screenshot capture failed before a complete artifact could be written.');
  } finally {
    // swallow-ok: best-effort unlink of a temp file during cleanup
    if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined);
  }
}

function unavailable(message: string): DomainFailure {
  return {
    ok: false,
    errorCode: 'SCREENSHOT_UNAVAILABLE',
    message: renderAgentMessage('tool', 'SCREENSHOT_UNAVAILABLE', 'capture-failed', { message }),
    retryable: false,
  };
}

function budgetFailure(decision: BudgetDecision): DomainFailure {
  return {
    ok: false,
    errorCode: decision.code,
    message: decision.message,
    retryable: false,
    details: { budget_limit: decision.limit },
  };
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
    (byte, index) => bytes[index] === byte,
  );
}
