// @no-llm
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

    it('claims lease.json naming this process, and writes no .lock (FEAT-064)', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createRun(makeRequest());
      const lease = JSON.parse(await readFile(join(runDir, 'lease.json'), 'utf8')) as {
        run_id: string;
        owner: { pid: number };
        origin: string;
        command: string[];
      };
      expect(lease).toMatchObject({
        run_id: runId,
        owner: { pid: process.pid },
        origin: 'terminal',
        command: ['run'],
      });
      expect(await readdir(runDir)).not.toContain('.lock');
      expect(store.ownership(runId)?.lease.run_id).toBe(runId);
      await store.releaseOwnership(runId);
    });

    it('takes the lease origin from the receipt', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId } = await store.createRun({
        ...makeRequest(),
        receipt: { invoked_by: 'daemon' } as unknown as NonNullable<RunRequest['receipt']>,
      });
      expect(store.ownership(runId)?.lease.origin).toBe('daemon');
      await store.releaseOwnership(runId);
    });

    it('claims before the first manifest is written', async () => {
      const order: string[] = [];
      const store = new LocalRunStore(tmpDir, {
        openSession: async (options) => {
          const files = await readdir(options.runDir);
          order.push(`claim(manifest=${files.includes('manifest.json')})`);
          const { RunOwnershipSession } =
            await import('../../../src/run-ownership/ownership-session.js');
          return RunOwnershipSession.open(options);
        },
      });
      const { runId, runDir } = await store.createAgentRun({ taskId: 't', command: 'do' });
      order.push(`manifest=${(await readdir(runDir)).includes('manifest.json')}`);
      expect(order).toEqual(['claim(manifest=false)', 'manifest=true']);
      await store.releaseOwnership(runId);
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
      // The dynamic import of the orchestrator module dominates this test.
    }, 30_000);
  });

  describe('listRuns', () => {
    it('returns empty array when no runs exist', async () => {
      const store = new LocalRunStore(tmpDir);
      const list = await store.listRuns();
      expect(list).toHaveLength(0);
    });

    it('skips legacy task manifests that do not have workflow run metadata', async () => {
      await mkdir(join(tmpDir, '000-legacy-task'));
      await writeFile(
        join(tmpDir, '000-legacy-task', 'manifest.json'),
        JSON.stringify({
          task_id: 'task-1',
          type: 'ask',
          query: 'latest local news',
          started_at: '2026-05-11T09:12:34.000Z',
          status: 'ok',
        }),
      );
      await mkdir(join(tmpDir, '001-workflow-run'));
      await writeFile(
        join(tmpDir, '001-workflow-run', 'manifest.json'),
        JSON.stringify({
          runId: 'workflow-run-1',
          workflowName: 'test-workflow',
          workflowVersion: 1,
          startedAt: '2026-05-11T10:12:34.000Z',
          status: 'completed',
        }),
      );

      const store = new LocalRunStore(tmpDir);

      await expect(store.listRuns()).resolves.toMatchObject([{ runId: 'workflow-run-1' }]);
    });

    it.each([undefined, null, 42])(
      'skips workflow manifests whose startedAt is not a string (%j)',
      async (startedAt) => {
        await mkdir(join(tmpDir, 'invalid-workflow-run'));
        await writeFile(
          join(tmpDir, 'invalid-workflow-run', 'manifest.json'),
          JSON.stringify({
            runId: 'invalid-workflow-run',
            workflowName: 'test-workflow',
            workflowVersion: 1,
            ...(startedAt === undefined ? {} : { startedAt }),
            status: 'completed',
          }),
        );

        const store = new LocalRunStore(tmpDir);

        await expect(store.listRuns()).resolves.toEqual([]);
      },
    );
  });

  describe('getRun', () => {
    it('returns null for non-existent run', async () => {
      const store = new LocalRunStore(tmpDir);
      const result = await store.getRun('nonexistent-run-id');
      expect(result).toBeNull();
    });
  });

  describe('releaseOwnership', () => {
    it('is a no-op for a run this store never owned', async () => {
      const store = new LocalRunStore(tmpDir);
      await expect(store.releaseOwnership('nonexistent-run-id')).resolves.toBeUndefined();
    });

    it('removes lease.json, and is idempotent', async () => {
      const store = new LocalRunStore(tmpDir);
      const { runId, runDir } = await store.createRun(makeRequest());
      await store.releaseOwnership(runId);
      await store.releaseOwnership(runId);
      expect(await readdir(runDir)).not.toContain('lease.json');
      expect(store.ownership(runId)).toBeUndefined();
    });
  });
});

describe('LocalRunStore task outcome fields (FEAT-054)', () => {
  it('writes taskOutcome and terminationReason when given, and leaves them absent otherwise', async () => {
    const store = new LocalRunStore(tmpDir);
    const first = await store.createAgentRun({
      taskId: 'task-1',
      command: 'do',
      partialAgent: { provider: 'anthropic', model: 'claude-sonnet' },
    });
    const second = await store.createAgentRun({
      taskId: 'task-2',
      command: 'ask',
      partialAgent: { provider: 'anthropic', model: 'claude-sonnet' },
    });

    await store.updateRunStatus(first.runId, {
      status: 'failed',
      endedAt: '2026-10-15T12:00:00.000Z',
      failureClass: 'requirements_unmet',
      taskOutcome: 'partial',
      terminationReason: 'model_finished',
    });
    await store.updateRunStatus(second.runId, { status: 'completed' });

    const written = JSON.parse(await readFile(join(first.runDir, 'manifest.json'), 'utf8')) as {
      taskOutcome?: string;
      terminationReason?: string;
      failureClass?: string;
    };
    expect(written).toMatchObject({
      taskOutcome: 'partial',
      terminationReason: 'model_finished',
      failureClass: 'requirements_unmet',
    });
    const older = JSON.parse(
      await readFile(join(second.runDir, 'manifest.json'), 'utf8'),
    ) as object;
    expect('taskOutcome' in older).toBe(false);
    expect('terminationReason' in older).toBe(false);
    expect((await store.getRun(second.runId))?.manifest.taskOutcome).toBeUndefined();
  });
});
