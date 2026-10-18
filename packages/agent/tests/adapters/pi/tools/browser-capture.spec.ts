/** @no-llm FEAT-058 TASK-004: the local deliverable capture tool. */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeliverableCaptureError,
  SensitiveScreenLatch,
  SetOfMarksError,
  StaleElementRefError,
  type AgentBrowserController,
  type AgentDeliverableCapture,
  type DeliverableCaptureRequest,
} from '@yantra/core';
import { ArtifactRef } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserCaptureSpec } from '../../../../src/adapters/pi/tools/browser-capture.js';
import { browserScreenshotSpec } from '../../../../src/adapters/pi/tools/browser-screenshot.js';
import { taskContractSpec } from '../../../../src/adapters/pi/tools/task-contract.js';
import { BudgetTracker, DEFAULT_BUDGET_LIMITS } from '../../../../src/runtime/budget.js';
import { renderAgentMessage } from '../../../../src/runtime/messages.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps } from '../../../../src/runtime/run-services.js';
import { resolveVisionAvailability } from '../../../../src/runtime/vision.js';

import { allowingEthics, buildServices } from './test-support.js';

const dirs: string[] = [];
const CANARY = 'sk-live-CAPTURE-CANARY-7731';

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A minimal PNG header of the given size, distinct per `seed`. */
function png(width = 4, height = 3, seed = 0): Buffer {
  const bytes = Buffer.alloc(32);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(seed, 28);
  return bytes;
}

function tile(seed = 0, width = 4, height = 3) {
  return { png: png(width, height, seed), width, height };
}

type CaptureFn = (request: DeliverableCaptureRequest) => Promise<AgentDeliverableCapture>;

const viewportCapture: CaptureFn = async (request) => ({
  scope: request.scope,
  ...(request.ref === undefined ? {} : { ref: request.ref }),
  tiles: [tile(1)],
  complete: true,
  labels: [],
});

const threeTiles: CaptureFn = async () => ({
  scope: 'full_page',
  tiles: [tile(1, 4, 4096), tile(2, 4, 4096), tile(3, 4, 808)],
  complete: true,
  labels: [],
  capturedHeight: 9000,
  pageHeight: 9000,
});

async function fixture(capture: CaptureFn = viewportCapture, options: { vision?: boolean } = {}) {
  const runDir = await mkdtemp(join(tmpdir(), 'yantra-capture-'));
  dirs.push(runDir);
  const latch = new SensitiveScreenLatch();
  const controller = {
    beginToolCall: vi.fn(),
    captureDeliverable: vi.fn(capture),
    capturePng: vi.fn(async () => ({
      png: png(2, 2),
      width: 2,
      height: 2,
      scope: 'viewport' as const,
      marks: 0,
    })),
    topLevelDocumentEpoch: () => 1,
    host: () => 'example.test',
  } as unknown as AgentBrowserController & {
    captureDeliverable: ReturnType<typeof vi.fn>;
  };
  const browser: BrowserToolDeps = {
    controller,
    ethics: allowingEthics(),
    secretResolver: null,
    sensitiveScreenLatch: latch,
    secretHosts: () => Promise.resolve([]),
    captureThresholdBytes: 16_384,
  };
  const services = buildServices({
    runDir,
    domain: { browser },
    vision: resolveVisionAvailability({
      grantEnabled: options.vision === true,
      hasBrowserTools: true,
      modelImageInput: options.vision === true,
      suppressedByFlag: false,
      zeroLlm: false,
    }),
  });
  const tool = wrapTool(browserCaptureSpec(services), services);
  return { runDir, latch, controller, tool, services };
}

async function screenshotFiles(runDir: string): Promise<string[]> {
  try {
    return (await readdir(join(runDir, 'screenshots'))).sort();
  } catch {
    // swallow-ok: a missing directory means nothing was written
    return [];
  }
}

describe('@no-llm browser_capture', () => {
  it('writes one PNG whose bytes hash to its recorded sha256, and shows the model metadata only', async () => {
    const { runDir, tool } = await fixture();

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.status).toBe('ok');
    const refs = (result.details as { artifacts: ArtifactRef[] }).artifacts;
    expect(refs).toHaveLength(1);
    const ref = ArtifactRef.parse(refs[0]);
    expect(ref).toMatchObject({ kind: 'screenshot', mime_type: 'image/png', sent_to_model: false });
    expect(ref.path).toMatch(/^screenshots\/capture-1-[a-f0-9]{12}\.png$/);
    const bytes = await readFile(join(runDir, ref.path));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(ref.sha256);
    expect(ref.path).toContain(ref.sha256.slice(0, 12));
    expect(result.content).toBeUndefined();
    expect(result.modelText).not.toContain(ref.sha256);
    expect(result.modelText).not.toMatch(/sha256|base64|data:|iVBORw0KGgo/);
    expect(JSON.parse(result.modelText)).toMatchObject({
      scope: 'viewport',
      complete: true,
      labels: [],
      parts: [{ path: ref.path, width: 4, height: 3, bytes: bytes.byteLength, part: 1 }],
      remaining_captures: 3,
      saved_locally: true,
    });
  });

  it.skipIf(process.platform === 'win32')('uses owner-only POSIX modes', async () => {
    const { runDir, tool } = await fixture();
    const result = await tool.execute({ scope: 'viewport' }, undefined);
    const ref = (result.details as { artifacts: ArtifactRef[] }).artifacts[0]!;

    expect((await stat(join(runDir, 'screenshots'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(runDir, ref.path))).mode & 0o777).toBe(0o600);
  });

  it('writes a three-tile full page as -p1 to -p3 with three local refs', async () => {
    const { runDir, tool, services } = await fixture(threeTiles);

    const result = await tool.execute({ scope: 'full_page' }, undefined);

    expect(result.status).toBe('ok');
    const refs = (result.details as { artifacts: ArtifactRef[] }).artifacts;
    expect(refs.map((ref) => ref.path)).toEqual([
      expect.stringMatching(/^screenshots\/capture-1-[a-f0-9]{12}-p1\.png$/),
      expect.stringMatching(/^screenshots\/capture-1-[a-f0-9]{12}-p2\.png$/),
      expect.stringMatching(/^screenshots\/capture-1-[a-f0-9]{12}-p3\.png$/),
    ]);
    expect(refs.every((ref) => ref.sent_to_model === false)).toBe(true);
    expect(await screenshotFiles(runDir)).toHaveLength(3);
    expect(JSON.parse(result.modelText)).toMatchObject({
      captured_height: 9000,
      page_height: 9000,
      parts: [{ part: 1 }, { part: 2 }, { part: 3 }],
    });
    expect(services.budgets.snapshot().deliverableCaptureBytes).toBe(
      refs.reduce((sum, ref) => sum + ref.bytes, 0),
    );
  });

  it('passes the budget bounds and the ref to the controller', async () => {
    const { controller, tool } = await fixture();

    await tool.execute({ scope: 'element', ref: 'e7' }, undefined);

    expect(controller.captureDeliverable).toHaveBeenCalledWith({
      scope: 'element',
      ref: 'e7',
      bounds: { tileWidth: 1920, tileHeight: 4096, maxParts: 6 },
    });
  });

  it('labels an incomplete set honestly', async () => {
    const { tool } = await fixture(async () => ({
      scope: 'full_page',
      tiles: Array.from({ length: 6 }, (_, index) => tile(index + 1, 4, 4096)),
      complete: false,
      labels: ['truncated'],
      capturedHeight: 24_576,
      pageHeight: 30_000,
    }));

    const result = await tool.execute({ scope: 'full_page' }, undefined);

    expect(JSON.parse(result.modelText)).toMatchObject({
      complete: false,
      labels: ['truncated'],
      captured_height: 24_576,
      page_height: 30_000,
    });
  });

  it('refuses a latched screen before reserving or capturing, and writes nothing', async () => {
    const { runDir, latch, controller, tool, services } = await fixture();
    latch.latch(1);

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('SCREENSHOT_SENSITIVE_SCREEN');
    expect(controller.captureDeliverable).not.toHaveBeenCalled();
    expect(services.budgets.snapshot().deliverableCaptureCount).toBe(0);
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('refuses when the latch is missing (fail closed)', async () => {
    const { runDir, tool, services } = await fixture();
    const browser = services.domain.browser as { sensitiveScreenLatch?: unknown };
    delete browser.sensitiveScreenLatch;

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('SCREENSHOT_SENSITIVE_SCREEN');
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('refuses the fifth call with deliverable-capture-count', async () => {
    const { tool } = await fixture();
    for (let call = 0; call < 4; call += 1) {
      expect((await tool.execute({ scope: 'viewport' }, undefined)).status).toBe('ok');
    }

    const fifth = await tool.execute({ scope: 'viewport' }, undefined);

    expect(fifth.error_code).toBe('BUDGET_EXHAUSTED');
    expect(fifth.details).toMatchObject({ budget_limit: 'deliverable-capture-count' });
  });

  it('refuses a tile over 8 MiB with deliverable-capture-bytes and writes nothing', async () => {
    const huge = Buffer.concat([png(4, 3), Buffer.alloc(8 * 1024 * 1024)]);
    const { runDir, tool } = await fixture(async () => ({
      scope: 'viewport',
      tiles: [{ png: huge, width: 4, height: 3 }],
      complete: true,
      labels: [],
    }));

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('BUDGET_EXHAUSTED');
    expect(result.details).toMatchObject({ budget_limit: 'deliverable-capture-bytes' });
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('refuses a tile over the pixel bound with deliverable-capture-pixels', async () => {
    const { runDir, tool } = await fixture(async () => ({
      scope: 'viewport',
      tiles: [tile(1, 3840, 2160)],
      complete: true,
      labels: [],
    }));

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.details).toMatchObject({ budget_limit: 'deliverable-capture-pixels' });
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('keeps the deliverable and Vision Assist budgets separate', async () => {
    const { tool, services } = await fixture(viewportCapture, { vision: true });
    for (let call = 0; call < 4; call += 1) await tool.execute({ scope: 'viewport' }, undefined);

    expect(services.budgets.snapshot()).toMatchObject({
      captureCount: 0,
      deliverableCaptureCount: 4,
    });

    const screenshot = wrapTool(browserScreenshotSpec(services), services);
    expect((await screenshot.execute({}, undefined)).status).toBe('ok');
    expect(services.budgets.snapshot()).toMatchObject({
      captureCount: 1,
      deliverableCaptureCount: 4,
    });
  });

  it('leaves the deliverable counters at zero after Vision Assist captures', async () => {
    const { services } = await fixture(viewportCapture, { vision: true });
    const screenshot = wrapTool(browserScreenshotSpec(services), services);

    await screenshot.execute({}, undefined);
    await screenshot.execute({}, undefined);

    expect(services.budgets.snapshot()).toMatchObject({
      captureCount: 2,
      deliverableCaptureCount: 0,
      deliverableCaptureBytes: 0,
    });
  });

  it('removes the tiles already written when a later tile fails, so no files remain', async () => {
    const tiles = [tile(1, 4, 4096), tile(2, 4, 4096)];
    const { runDir, tool } = await fixture(async () => ({
      scope: 'full_page',
      tiles,
      complete: true,
      labels: [],
      capturedHeight: 8192,
      pageHeight: 8192,
    }));
    // Occupy the second tile's final path with a directory so its rename fails.
    const sha = createHash('sha256').update(tiles[1]!.png).digest('hex').slice(0, 12);
    await mkdir(join(runDir, 'screenshots', `capture-1-${sha}-p2.png`, 'blocker'), {
      recursive: true,
    });

    const result = await tool.execute({ scope: 'full_page' }, undefined);

    expect(result.error_code).toBe('CAPTURE_UNAVAILABLE');
    const files = (await screenshotFiles(runDir)).filter((name) => !name.endsWith('-p2.png'));
    expect(files).toEqual([]);
  });

  it('requires a ref for element scope, naming browser_observe', async () => {
    const { controller, tool } = await fixture();

    const result = await tool.execute({ scope: 'element' }, undefined);

    expect(result.error_code).toBe('INVALID_INPUT');
    expect(result.modelText).toContain('browser_observe');
    expect(JSON.parse(result.modelText).message).toBe(
      renderAgentMessage('tool', 'INVALID_INPUT', 'capture-ref-required'),
    );
    expect(controller.captureDeliverable).not.toHaveBeenCalled();
  });

  it('forbids a ref with viewport or full_page scope', async () => {
    const { tool } = await fixture();

    const result = await tool.execute({ scope: 'viewport', ref: 'e3' }, undefined);

    expect(JSON.parse(result.modelText).message).toBe(
      renderAgentMessage('tool', 'INVALID_INPUT', 'capture-ref-forbidden'),
    );
  });

  it('rejects an unknown parameter and a malformed ref at the schema', async () => {
    const { tool } = await fixture();

    expect((await tool.execute({ scope: 'viewport', marks: true }, undefined)).error_code).toBe(
      'INVALID_INPUT',
    );
    expect((await tool.execute({ scope: 'element', ref: 'x1' }, undefined)).error_code).toBe(
      'INVALID_INPUT',
    );
  });

  it.each([
    ['a stale ref', new StaleElementRefError('e9'), 'STALE_ELEMENT_REF', null],
    [
      'a navigation during capture',
      new SetOfMarksError('SET_OF_MARKS_EPOCH_CHANGED', 'changed'),
      'CAPTURE_UNAVAILABLE',
      'epoch-changed',
    ],
    [
      'the marks overlay',
      new DeliverableCaptureError('overlay-present', 'overlay'),
      'CAPTURE_UNAVAILABLE',
      'overlay-present',
    ],
    [
      'an oversized tile',
      new DeliverableCaptureError('bounds-exceeded', 'big'),
      'CAPTURE_UNAVAILABLE',
      'bounds-exceeded',
    ],
    ['anything else', new Error('cdp died'), 'CAPTURE_UNAVAILABLE', 'capture-failed'],
  ] as const)('maps %s to %s and writes nothing', async (_label, error, code, cause) => {
    const { runDir, tool } = await fixture(() => Promise.reject(error));

    const result = await tool.execute({ scope: 'element', ref: 'e9' }, undefined);

    expect(result.error_code).toBe(code);
    if (cause !== null) {
      expect(JSON.parse(result.modelText).message).toBe(
        renderAgentMessage('tool', 'CAPTURE_UNAVAILABLE', cause),
      );
    }
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('refuses a non-PNG tile', async () => {
    const { runDir, tool } = await fixture(async () => ({
      scope: 'viewport',
      tiles: [{ png: Buffer.from('not a png at all'), width: 4, height: 3 }],
      complete: true,
      labels: [],
    }));

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('CAPTURE_UNAVAILABLE');
    expect(await screenshotFiles(runDir)).toEqual([]);
  });

  it('reports CAPTURE_UNAVAILABLE no-browser without a browser', async () => {
    const services = buildServices();
    const tool = wrapTool(browserCaptureSpec(services), services);

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('CAPTURE_UNAVAILABLE');
    expect(JSON.parse(result.modelText).message).toBe(
      renderAgentMessage('tool', 'CAPTURE_UNAVAILABLE', 'no-browser'),
    );
  });

  it('counts calls, files, and bytes in run health on success only', async () => {
    const { tool, services } = await fixture(threeTiles);
    services.runHealth.recordCaptureCapability(services.capture);

    await tool.execute({ scope: 'full_page' }, undefined);
    await tool.execute({ scope: 'element' }, undefined);

    const capture = services.runHealth.summary({
      runId: 'run',
      snapshot: { navigations: 0, hosts: 0 },
      limits: { maxNavigations: 30, maxHosts: 20 },
      noticeCount: 0,
    }).capture;
    expect(capture).toMatchObject({ deliverable_calls: 1, deliverable_files: 3 });
    expect(capture?.deliverable_bytes).toBeGreaterThan(0);
  });

  it('records one ledger capture per call, cited by part 1 and equal to its audit ref', async () => {
    const { tool, services } = await fixture(threeTiles);

    const result = await tool.execute({ scope: 'full_page' }, undefined);

    const refs = (result.details as { artifacts: ArtifactRef[] }).artifacts;
    const entries = services.actionLedger.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'capture',
      scope: 'full_page',
      producer: 'browser_capture',
      path: refs[0]!.path,
      sha256: refs[0]!.sha256,
      bytes: refs.reduce((sum, ref) => sum + ref.bytes, 0),
      parts: 3,
      complete: true,
      epoch: 1,
    });
    expect(
      entries[0]?.kind === 'capture' ? entries[0].captureSet?.parts.map((part) => part.path) : [],
    ).toEqual(refs.map((ref) => ref.path));
  });

  it('records nothing in the ledger when a capture fails', async () => {
    const { tool, services, latch } = await fixture();
    latch.latch(1);
    await tool.execute({ scope: 'viewport' }, undefined);

    expect(services.actionLedger.entries()).toEqual([]);
  });

  it('is exempt from the soft wind-down only', async () => {
    const { tool } = await fixture();
    const spec = browserCaptureSpec(buildServices());

    expect(typeof spec.windDownExempt).toBe('function');
    if (typeof spec.windDownExempt === 'function')
      expect(spec.windDownExempt(buildServices(), { scope: 'viewport' })).toBe(false);
    expect(spec.terminal).toBeUndefined();
    expect(tool.description).toContain('NOT shown to you');
  });
  it('does not fail a capture when its advisory progress source fails', async () => {
    const { services } = await fixture();
    vi.spyOn(services.progress, 'captureExemptionAvailable').mockImplementation(() => {
      throw new TypeError('fixture ledger unavailable');
    });
    services.budgets.freezeExploration();
    const result = await wrapTool(browserCaptureSpec(services), services).execute(
      { scope: 'viewport' },
      undefined,
    );
    expect(result.status).toBe('ok');
    expect(services.budgets.isFrozen()).toBe(false);
    expect(services.progress.summary()).toMatchObject({ mode: 'observe', progress_error: true });
  });

  it.each(['soft', 'freeze'] as const)(
    'reserves a requested capture once during %s closure',
    async (closure) => {
      const { services: base } = await fixture();
      let clock = 0;
      const services = {
        ...base,
        budgets: new BudgetTracker({ ...DEFAULT_BUDGET_LIMITS, wallClockMs: 1000 }, () => clock),
      };
      const declare = wrapTool(taskContractSpec(services), services);
      expect(
        (
          await declare.execute(
            {
              deliverable: 'actions',
              subject: 'a saved screenshot',
              artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
            },
            undefined,
          )
        ).status,
      ).toBe('ok');
      if (closure === 'soft') clock = 850;
      else services.budgets.freezeExploration();
      const tool = wrapTool(browserCaptureSpec(services), services);
      expect((await tool.execute({ scope: 'viewport' }, undefined)).status).toBe('ok');
      const again = await tool.execute({ scope: 'viewport' }, undefined);
      expect(again.error_code).toBe('BUDGET_EXHAUSTED');
      expect(again.details).toMatchObject({
        budget_limit: closure === 'soft' ? 'wall-clock-soft' : 'stalled',
      });
      clock = 1000;
      expect((await tool.execute({ scope: 'viewport' }, undefined)).details).toMatchObject({
        budget_limit: 'wall-clock',
      });
    },
  );

  it('keeps a canary out of every artifact when a secret fill latched the screen', async () => {
    const { runDir, latch, tool } = await fixture();
    // A stored-secret fill latches the current document.
    latch.latch(1);

    const result = await tool.execute({ scope: 'viewport' }, undefined);

    expect(result.error_code).toBe('SCREENSHOT_SENSITIVE_SCREEN');
    expect(JSON.stringify(result)).not.toContain(CANARY);
    const files = await screenshotFiles(runDir);
    for (const name of files) {
      expect((await readFile(join(runDir, 'screenshots', name))).includes(CANARY)).toBe(false);
    }
    expect(files).toEqual([]);
  });
});
