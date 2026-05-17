// @no-llm
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Plan } from '@yantra/protocol';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RunDirMissingError, RunNotResumableError } from '../../../src/workflow/replay/errors.js';
import { loadResumePoint, requiresUserConsent } from '../../../src/workflow/replay/resume.js';
import type { RunManifest, RunStore } from '../../../src/workflow/replay/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'yantra-resume-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-001',
    taskId: 'TASK001',
    workflowName: 'test-workflow',
    workflowVersion: 1,
    params: {},
    startedAt: '2026-05-11T09:12:34.000Z',
    endedAt: '2026-05-11T09:12:45.000Z',
    status: 'failed',
    durationMs: 11000,
    failureClass: 'locator_not_found',
    profileKind: 'workflow',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  };
}

function makePlan(): Plan {
  return {
    task_id: '01JCVW8HFNQBHRNZ4MPCB0AKZ0' as Plan['task_id'],
    plan_id: '01JCVW8HFNQBHRNZ4MPCB0AKZ1' as Plan['plan_id'],
    schema_version: '0.1',
    default_scope: 'public',
    steps: [
      {
        id: 's1',
        verb: 'navigate',
        url: 'https://example.com',
        scope: 'public',
      } as Plan['steps'][number],
      {
        id: 's2',
        verb: 'click',
        locator: { candidates: [] },
        scope: 'public',
      } as Plan['steps'][number],
    ],
    outputs: [],
  };
}

function makeStore(overrides: Partial<RunStore> = {}): RunStore {
  return {
    createRun: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun: vi.fn().mockResolvedValue(null),
    updateRunStatus: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('loadResumePoint', () => {
  it('throws RunDirMissingError when run not found', async () => {
    const store = makeStore({ getRun: vi.fn().mockResolvedValue(null) });
    await expect(loadResumePoint(store, 'nonexistent')).rejects.toBeInstanceOf(RunDirMissingError);
  });

  it('throws RunNotResumableError when status is "completed"', async () => {
    const runDir = join(tmpDir, 'run-001');
    await mkdir(runDir);
    const manifest = makeManifest({ status: 'completed', failureClass: undefined });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    await expect(loadResumePoint(store, 'run-001')).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it('throws RunNotResumableError when status is "running"', async () => {
    const runDir = join(tmpDir, 'run-001');
    await mkdir(runDir);
    const manifest = makeManifest({ status: 'running', failureClass: undefined });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    await expect(loadResumePoint(store, 'run-001')).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it('throws RunNotResumableError for ephemeral profile', async () => {
    const runDir = join(tmpDir, 'run-001');
    await mkdir(runDir);
    const manifest = makeManifest({ status: 'failed', profileKind: 'ephemeral' });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    await expect(loadResumePoint(store, 'run-001')).rejects.toBeInstanceOf(RunNotResumableError);
  });

  it('loads resume point successfully for failed run', async () => {
    const runDir = join(tmpDir, 'run-001');
    await mkdir(runDir);
    const plan = makePlan();
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan));
    const manifest = makeManifest({ status: 'failed', profileKind: 'workflow' });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    const point = await loadResumePoint(store, 'run-001');
    expect(point.runId).toBe('run-001');
    expect(point.workflowName).toBe('test-workflow');
    expect(point.nextStepIndex).toBe(0); // no checkpoints → start from beginning
    expect(point.lastCheckpoint).toBeNull();
    expect(point.plan.steps).toHaveLength(2);
  });

  it('loads resume point for paused run', async () => {
    const runDir = join(tmpDir, 'run-002');
    await mkdir(runDir);
    const plan = makePlan();
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan));
    const manifest = makeManifest({ runId: 'run-002', status: 'paused', profileKind: 'workflow' });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    const point = await loadResumePoint(store, 'run-002');
    expect(point.runId).toBe('run-002');
  });

  it('computes nextStepIndex from checkpoint', async () => {
    const runDir = join(tmpDir, 'run-003');
    const checkpointsDir = join(runDir, 'checkpoints');
    await mkdir(checkpointsDir, { recursive: true });
    const plan = makePlan();
    await writeFile(join(runDir, 'plan.json'), JSON.stringify(plan));

    // Write a checkpoint for s1 (idx=0) → nextStepIndex should be 1
    const checkpoint = {
      schema_version: '0.1',
      run_id: 'run-003',
      task_id: 'TASK001',
      after_step_id: 's1',
      after_step_idx: 0,
      ts: new Date().toISOString(),
      page_url: 'https://example.com',
      captures: {},
      scope_chain: ['public'],
      budgets: { locator: 3, step: 10, workflow: 30 },
    };
    await writeFile(join(checkpointsDir, 's1.json'), JSON.stringify(checkpoint));

    const manifest = makeManifest({ runId: 'run-003', status: 'failed', profileKind: 'workflow' });
    const store = makeStore({
      getRun: vi.fn().mockResolvedValue({ manifest, runDir }),
    });
    const point = await loadResumePoint(store, 'run-003');
    expect(point.nextStepIndex).toBe(1);
    expect(point.lastCheckpoint?.after_step_id).toBe('s1');
  });
});

describe('requiresUserConsent', () => {
  it('returns true for scope_violation', () => {
    expect(requiresUserConsent('scope_violation')).toBe(true);
  });

  it('returns true for ethics_refused', () => {
    expect(requiresUserConsent('ethics_refused')).toBe(true);
  });

  it('returns false for locator_not_found', () => {
    expect(requiresUserConsent('locator_not_found')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(requiresUserConsent(undefined)).toBe(false);
  });

  it('returns false for network_error', () => {
    expect(requiresUserConsent('network_error')).toBe(false);
  });
});
