// @no-llm
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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

  describe('agentic startup lifecycle', () => {
    it('creates the initial manifest before provider validation', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createAgentRun({
        taskId: 'task-1',
        command: 'do',
        partialAgent: { provider: 'anthropic', model: 'claude-sonnet' },
      });

      const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
        runId: string;
        status: string;
        runKind: string;
        agent: Record<string, unknown>;
      };
      expect(manifest).toMatchObject({ runId, status: 'running', runKind: 'agentic' });
      expect(manifest.agent).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
    });

    it('finalizes startup failures with a typed manifest error, event, and report', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createAgentRun({
        taskId: 'task-2',
        command: 'do',
        partialAgent: { provider: 'anthropic' },
      });

      await store.finalizeStartupFailure(runId, {
        code: 'AGENT_AUTH_UNAVAILABLE',
        message: 'No managed or environment credential is configured.',
      });

      const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as {
        status: string;
        agent: Record<string, unknown>;
        agentError: { code: string; message: string };
      };
      expect(manifest.status).toBe('failed');
      expect(manifest.agent).toEqual({ provider: 'anthropic' });
      expect(manifest.agentError.code).toBe('AGENT_AUTH_UNAVAILABLE');

      const events = await readFile(join(runDir, 'events.jsonl'), 'utf8');
      expect(events).toContain('"kind":"task_failed"');
      const report = await readFile(join(runDir, 'report.md'), 'utf8');
      expect(report).toContain('Failure class: AGENT_AUTH_UNAVAILABLE');
      expect(report).toContain('No managed or environment credential');
    });

    it('keeps retries in one run directory and maps the failure outcome to exit code 2', async () => {
      const store = new LocalRunStore(tmpDir);
      const created = await store.createAgentRun({ taskId: 'task-3', command: 'do' });

      await store.finalizeStartupFailure(created.runId, {
        code: 'AGENT_SESSION_START_FAILED',
        message: 'Provider initialization failed.',
      });
      await store.finalizeStartupFailure(created.runId, {
        code: 'AGENT_SESSION_START_FAILED',
        message: 'Provider initialization failed again.',
      });

      expect(await readdir(tmpDir)).toEqual([created.runId]);
      const { exitCodeFor } = await import('../../../src/workflow/replay/run-orchestrator.js');
      expect(
        exitCodeFor({
          kind: 'failure',
          runId: created.runId,
          failureClass: 'unexpected',
          failureDetail: {
            failureClass: 'unexpected',
            stepId: '',
            message: 'Agent startup failed.',
          },
        }),
      ).toBe(2);
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
