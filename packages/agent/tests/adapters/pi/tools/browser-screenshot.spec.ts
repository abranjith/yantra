import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SensitiveScreenLatch,
  StaleElementRefError,
  type AgentBrowserController,
  type AgentScreenshotCapture,
} from '@yantra/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserScreenshotSpec } from '../../../../src/adapters/pi/tools/browser-screenshot.js';
import { wrapTool } from '../../../../src/runtime/middleware.js';
import type { BrowserToolDeps } from '../../../../src/runtime/run-services.js';
import { resolveVisionAvailability } from '../../../../src/runtime/vision.js';

import { allowingEthics, buildServices } from './test-support.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function png(width = 2, height = 2): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function fixture(
  capture: (ref?: string) => Promise<AgentScreenshotCapture> = async (ref) => ({
    png: png(),
    width: 2,
    height: 2,
    scope: ref === undefined ? 'viewport' : 'element',
    ...(ref === undefined ? {} : { ref }),
    marks: 2,
  }),
) {
  const runDir = await mkdtemp(join(tmpdir(), 'yantra-screenshot-'));
  dirs.push(runDir);
  const latch = new SensitiveScreenLatch();
  const controller = {
    beginToolCall: vi.fn(),
    capturePng: vi.fn(capture),
    topLevelDocumentEpoch: () => 1,
    host: () => 'example.test',
  } as unknown as AgentBrowserController;
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
      grantEnabled: true,
      hasBrowserTools: true,
      modelImageInput: true,
      suppressedByFlag: false,
      zeroLlm: false,
    }),
  });
  const tool = wrapTool(browserScreenshotSpec(services), services);
  return { runDir, latch, controller, tool, services };
}

describe('@no-llm browser_screenshot', () => {
  it('writes exactly one private PNG whose hash matches metadata', async () => {
    const { runDir, tool } = await fixture();
    const result = await tool.execute({}, undefined);
    expect(result.status).toBe('ok');
    const artifacts = (result.details as { artifacts: Record<string, unknown>[] }).artifacts;
    expect(artifacts).toHaveLength(1);
    const metadata = artifacts[0]!;
    expect(metadata).toMatchObject({ kind: 'screenshot', sent_to_model: true });
    expect('captures' in (result.details as object)).toBe(false);
    const files = await readdir(join(runDir, 'screenshots'));
    expect(files).toHaveLength(1);
    const bytes = await readFile(join(runDir, metadata.path as string));
    expect([...bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
    expect(result.content?.map((part) => part.kind)).toEqual(['text', 'image']);
  });

  it('uses the resolved ref for an element-scoped capture', async () => {
    const { controller, tool } = await fixture();
    const result = await tool.execute({ ref: 'e7' }, undefined);
    expect(result.status).toBe('ok');
    expect(controller.capturePng).toHaveBeenCalledWith('e7');
    expect(JSON.parse(result.modelText)).toMatchObject({ scope: 'element', ref: 'e7' });
  });

  it.skipIf(process.platform === 'win32')('uses owner-only POSIX modes', async () => {
    const { runDir, tool } = await fixture();
    const result = await tool.execute({}, undefined);
    const metadata = (result.details as { artifacts: { path: string }[] }).artifacts[0]!;
    expect((await stat(join(runDir, 'screenshots'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(runDir, metadata.path))).mode & 0o777).toBe(0o600);
  });

  it('returns STALE_ELEMENT_REF and writes no file for an unresolved ref', async () => {
    const { runDir, tool } = await fixture(async () => {
      throw new StaleElementRefError('e99');
    });
    const result = await tool.execute({ ref: 'e99' }, undefined);
    expect(result.error_code).toBe('STALE_ELEMENT_REF');
    await expect(readdir(join(runDir, 'screenshots'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns SCREENSHOT_UNAVAILABLE with no partial file after capture failure', async () => {
    const { runDir, tool } = await fixture(() => Promise.reject(new Error('CDP failed')));
    const result = await tool.execute({}, undefined);
    expect(result.error_code).toBe('SCREENSHOT_UNAVAILABLE');
    await expect(readdir(join(runDir, 'screenshots'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('denies a latched screen before capture and writes no file', async () => {
    const { runDir, latch, controller, tool } = await fixture();
    latch.latch(1);
    const result = await tool.execute({}, undefined);
    expect(result.error_code).toBe('SCREENSHOT_SENSITIVE_SCREEN');
    expect(controller.capturePng).not.toHaveBeenCalled();
    await expect(readdir(join(runDir, 'screenshots'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('describes fallback evidence and never frames capture as the default view', async () => {
    const { tool } = await fixture();
    expect(tool.description).toContain('fallback visual evidence');
    expect(tool.description.toLowerCase()).not.toContain('see the page');
  });
});

describe('@no-llm browser_screenshot records captures in the action ledger (FEAT-054)', () => {
  it('records one capture with the audit path, hash, bytes, scope, and epoch', async () => {
    const { tool, services } = await fixture();

    const result = await tool.execute({}, undefined);

    const audit = (result.details as { artifacts: Record<string, unknown>[] }).artifacts[0]!;
    expect(services.actionLedger.entries()).toEqual([
      expect.objectContaining({
        kind: 'capture',
        scope: 'viewport',
        path: audit.path,
        sha256: audit.sha256,
        bytes: audit.bytes,
        producer: 'browser_screenshot',
        epoch: 1,
        host: 'example.test',
      }),
    ]);
  });

  it('records nothing when the capture is refused', async () => {
    const { tool, latch, services } = await fixture();
    latch.latch(1);

    const result = await tool.execute({}, undefined);

    expect(result.error_code).toBe('SCREENSHOT_SENSITIVE_SCREEN');
    expect(services.actionLedger.entries()).toEqual([]);
  });
});
