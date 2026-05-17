// @no-llm
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  writeManifest,
  readManifest,
  writeOutputs,
  redactParamsForManifest,
} from '../../../src/workflow/replay/manifest-writer.js';
import type { RunManifest, RunOutputs } from '../../../src/workflow/replay/types.js';

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-001',
    taskId: 'TASK001',
    workflowName: 'test-workflow',
    workflowVersion: 1,
    params: { month: '2026-04' },
    startedAt: '2026-05-11T09:12:34.000Z',
    endedAt: undefined,
    status: 'running',
    durationMs: undefined,
    failureClass: undefined,
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yantra-manifest-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('writeManifest / readManifest', () => {
  it('writes and reads back the manifest', async () => {
    const manifest = makeManifest();
    await writeManifest(tmpDir, manifest);
    const read = await readManifest(tmpDir);
    expect(read.runId).toBe('run-001');
    expect(read.workflowName).toBe('test-workflow');
    expect(read.status).toBe('running');
  });

  it('writes atomically (no .tmp file left behind)', async () => {
    const manifest = makeManifest();
    await writeManifest(tmpDir, manifest);
    await expect(stat(join(tmpDir, 'manifest.json.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('produces a valid JSON file', async () => {
    const manifest = makeManifest();
    await writeManifest(tmpDir, manifest);
    const raw = await readFile(join(tmpDir, 'manifest.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('preserves all fields round-trip', async () => {
    const manifest = makeManifest({
      status: 'completed',
      endedAt: '2026-05-11T09:13:00.000Z',
      durationMs: 26000,
    });
    await writeManifest(tmpDir, manifest);
    const read = await readManifest(tmpDir);
    expect(read.status).toBe('completed');
    expect(read.endedAt).toBe('2026-05-11T09:13:00.000Z');
    expect(read.durationMs).toBe(26000);
  });
});

describe('writeOutputs', () => {
  it('writes outputs.json', async () => {
    const outputs: RunOutputs = {
      runId: 'run-001',
      workflowName: 'test-workflow',
      createdAt: new Date().toISOString(),
      outputs: { title: 'Home' },
    };
    await writeOutputs(tmpDir, outputs);
    const raw = await readFile(join(tmpDir, 'outputs.json'), 'utf8');
    const parsed = JSON.parse(raw) as RunOutputs;
    expect(parsed.runId).toBe('run-001');
    expect(parsed.outputs).toEqual({ title: 'Home' });
  });
});

describe('redactParamsForManifest', () => {
  it('replaces declared secret keys', () => {
    const result = redactParamsForManifest({ apiKey: 'secret-value', month: '2026-04' }, [
      'apiKey',
    ]);
    expect(result['apiKey']).toEqual({ kind: 'secret', key: 'apiKey' });
    expect(result['month']).toBe('2026-04');
  });

  it('returns params unchanged when no secret keys declared', () => {
    const result = redactParamsForManifest({ month: '2026-04' }, []);
    expect(result).toEqual({ month: '2026-04' });
  });

  it('is case-sensitive for key matching', () => {
    const result = redactParamsForManifest({ ApiKey: 'secret' }, ['apiKey']);
    expect(result['ApiKey']).toBe('secret'); // key mismatch, not redacted
  });
});
