// @no-llm
/**
 * The one resumability rule (FEAT-067 TASK-013), shared by `yantra resume`
 * and the app's Resume action.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunDirMissingError, RunNotResumableError } from '../../../src/workflow/replay/errors.js';
import {
  NOT_A_WORKFLOW_RUN,
  assessResumability,
  checkResumable,
} from '../../../src/workflow/replay/resumability.js';
import { loadResumePoint } from '../../../src/workflow/replay/resume.js';
import type { RunManifest, RunStore } from '../../../src/workflow/replay/types.js';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'yantra-resumability-'));
});

afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-1',
    taskId: 'T1',
    workflowName: 'nightly',
    workflowVersion: 1,
    params: {},
    startedAt: '2026-11-14T10:00:00.000Z',
    endedAt: '2026-11-14T10:01:00.000Z',
    status: 'failed',
    durationMs: 60_000,
    failureClass: 'locator_not_found',
    profileKind: 'workflow',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  };
}

function store(found: RunManifest | null | Error): RunStore {
  return {
    createRun: vi.fn(),
    listRuns: vi.fn().mockResolvedValue([]),
    getRun:
      found instanceof Error
        ? vi.fn().mockRejectedValue(found)
        : vi.fn().mockResolvedValue(found === null ? null : { manifest: found, runDir }),
    updateRunStatus: vi.fn(),
    releaseOwnership: vi.fn(),
  };
}

async function withPlan(): Promise<void> {
  await writeFile(join(runDir, 'plan.json'), JSON.stringify({ steps: [{ id: 's1' }] }));
}

describe('@no-llm assessResumability', () => {
  it('allows a failed workflow run with a readable plan', async () => {
    await withPlan();

    expect(await assessResumability(store(manifest()), 'run-1')).toEqual({
      available: true,
      requiresConsent: false,
      failureClass: 'locator_not_found',
    });
  });

  it('allows a paused run, and one with no checkpoint (it resumes from step 0)', async () => {
    await withPlan();

    expect(
      (await assessResumability(store(manifest({ status: 'paused' })), 'run-1')).available,
    ).toBe(true);
    const point = await loadResumePoint(store(manifest({ status: 'paused' })), 'run-1');
    expect(point.nextStepIndex).toBe(0);
  });

  it('refuses a completed run, naming its status', async () => {
    await withPlan();

    expect(await assessResumability(store(manifest({ status: 'completed' })), 'run-1')).toEqual({
      available: false,
      reason:
        'Run "run-1" has status "completed" which is not resumable. Only failed or paused runs can be resumed.',
    });
  });

  it('refuses an ephemeral run, pointing at a fresh run of the workflow', async () => {
    await withPlan();

    const verdict = await assessResumability(
      store(manifest({ profileKind: 'ephemeral' })),
      'run-1',
    );

    expect(verdict).toMatchObject({ available: false });
    expect(verdict.available === false && verdict.reason).toMatch(/yantra run nightly/u);
  });

  it('refuses a run whose plan cannot be read', async () => {
    const verdict = await assessResumability(store(manifest()), 'run-1');

    expect(verdict).toEqual({
      available: false,
      reason: 'Run "run-1" plan.json could not be read. The run directory may be corrupted.',
    });
  });

  it('requires consent after a scope violation or an ethics refusal, without forbidding resume', async () => {
    await withPlan();

    expect(
      await assessResumability(store(manifest({ failureClass: 'scope_violation' })), 'run-1'),
    ).toEqual({
      available: true,
      requiresConsent: true,
      failureClass: 'scope_violation',
    });
    expect(
      await assessResumability(store(manifest({ failureClass: 'ethics_refused' })), 'run-1'),
    ).toMatchObject({ requiresConsent: true });
  });

  it('never resumes an agentic run', async () => {
    await withPlan();

    expect(
      await assessResumability(
        store(manifest({ runKind: 'agentic', workflowName: 'do' })),
        'run-1',
      ),
    ).toEqual({ available: false, reason: NOT_A_WORKFLOW_RUN });
  });

  it('says when there is no such run, and never throws on an unreadable manifest', async () => {
    expect(await assessResumability(store(null), 'run-1')).toEqual({
      available: false,
      reason: 'There is no run "run-1".',
    });
    expect(await assessResumability(store(new Error('EACCES')), 'run-1')).toEqual({
      available: false,
      reason: 'Run "run-1" has a manifest that could not be read.',
    });
  });
});

describe('@no-llm loadResumePoint shares the rule', () => {
  it('throws the assessment’s reason for every refusal', async () => {
    for (const [found, plan] of [
      [manifest({ status: 'completed' }), true],
      [manifest({ profileKind: 'ephemeral' }), true],
      [manifest(), false],
      [manifest({ runKind: 'agentic' }), true],
    ] as const) {
      await rm(join(runDir, 'plan.json'), { force: true });
      if (plan) await withPlan();
      const verdict = await checkResumable(store(found), 'run-1');

      const thrown = await loadResumePoint(store(found), 'run-1').catch(
        (caught: unknown) => caught,
      );

      expect(thrown).toBeInstanceOf(RunNotResumableError);
      expect((thrown as Error).message).toBe(verdict.available ? '' : verdict.reason);
    }
  });

  it('keeps the missing-run and unreadable-manifest errors it always threw', async () => {
    const original = new Error('EACCES: manifest');

    await expect(loadResumePoint(store(null), 'run-1')).rejects.toBeInstanceOf(RunDirMissingError);
    await expect(loadResumePoint(store(original), 'run-1')).rejects.toBe(original);
  });
});
