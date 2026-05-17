// @no-llm
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LocalRunStore, formatRunId } from '../../../src/workflow/replay/run-store.js';
import type { RunRequest } from '../../../src/workflow/replay/types.js';

function makeRequest(workflowName = 'test-workflow'): RunRequest {
  return {
    workflowName,
    params: {},
    budgets: {},
    json: false,
    debug: false,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yantra-run-store-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('formatRunId', () => {
  it('produces a compact ISO timestamp prefix', () => {
    const d = new Date('2026-05-11T09:12:34.000Z');
    const id = formatRunId(d, 'my-workflow', 'a1b2c3d4');
    expect(id).toMatch(/^20260511T091234Z-/);
  });

  it('sanitizes special characters in workflow name', () => {
    const d = new Date('2026-05-11T09:12:34.000Z');
    const id = formatRunId(d, 'My Wörkflow/v2!', 'a1b2c3d4');
    expect(id).not.toMatch(/[/ !ö]/);
  });

  it('includes the short UUID suffix', () => {
    const d = new Date('2026-05-11T09:12:34.000Z');
    const id = formatRunId(d, 'wf', 'a1b2c3d4');
    expect(id).toMatch(/a1b2c3d4$/);
  });
});

describe('LocalRunStore', () => {
  describe('createRun', () => {
    it('creates a directory and returns a runId and runDir', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createRun(makeRequest());
      expect(runId).toBeTruthy();
      expect(runDir).toContain(runId);
    });

    it('creates a .lock file in the run directory', async () => {
      const { readFile, stat } = await import('node:fs/promises');
      const store = new LocalRunStore(tmpDir);
      const { runDir } = await store.createRun(makeRequest());
      await expect(stat(join(runDir, '.lock'))).resolves.toBeTruthy();
      const lock = JSON.parse(await readFile(join(runDir, '.lock'), 'utf8')) as { pid: number };
      expect(lock.pid).toBe(process.pid);
    });
  });

  describe('listRuns', () => {
    it('returns empty array when no runs exist', async () => {
      const store = new LocalRunStore(tmpDir);
      const list = await store.listRuns();
      expect(list).toHaveLength(0);
    });
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const store = new LocalRunStore(tmpDir);
      const result = await store.getRun('nonexistent-run-id');
      expect(result).toBeNull();
    });
  });

  describe('releaseLock', () => {
    it('does not throw if .lock file does not exist', async () => {
      const store = new LocalRunStore(tmpDir);
      await expect(store.releaseLock('nonexistent-run-id')).resolves.toBeUndefined();
    });

    it('removes the .lock file after createRun', async () => {
      const { stat } = await import('node:fs/promises');
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createRun(makeRequest());
      await store.releaseLock(runId);
      await expect(stat(join(runDir, '.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });
});
