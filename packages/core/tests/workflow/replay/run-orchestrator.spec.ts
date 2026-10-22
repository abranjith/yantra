// @no-llm
import { TASK_OUTCOME_TABLE, type TaskOutcome } from '@yantra/protocol';
import { describe, it, expect } from 'vitest';

import {
  exitCodeFor,
  taskOutcomeForReplay,
} from '../../../src/workflow/replay/run-orchestrator.js';
import type { OrchestratorRunOutcome } from '../../../src/workflow/replay/types.js';

describe('exitCodeFor', () => {
  it('returns 0 for success', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'success',
      runId: 'run-001',
      outputs: {},
    };
    expect(exitCodeFor(outcome)).toBe(0);
  });

  it('returns 4 for user-handoff aborted', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'aborted',
      runId: 'run-001',
      reason: 'user-handoff',
    };
    expect(exitCodeFor(outcome)).toBe(4);
  });

  // REV-011: `aborted` exits 130 under `run` exactly as under `do`, `ask`, and `research`.
  it('returns 130 for user-abort, the same code the agentic commands use', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'aborted',
      runId: 'run-001',
      reason: 'user-abort',
    };
    expect(exitCodeFor(outcome)).toBe(130);
    expect(exitCodeFor(outcome)).toBe(TASK_OUTCOME_TABLE.aborted.exitCode);
  });

  it('returns 2 for scope-violation aborted', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'aborted',
      runId: 'run-001',
      reason: 'scope-violation',
    };
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('returns 2 for ethics-refused aborted', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'aborted',
      runId: 'run-001',
      reason: 'ethics-refused',
    };
    expect(exitCodeFor(outcome)).toBe(2);
  });

  it('returns 2 for failure', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'failure',
      runId: 'run-001',
      failureClass: 'locator_not_found',
      failureDetail: { failureClass: 'locator_not_found', stepId: 's1', message: 'not found' },
    };
    expect(exitCodeFor(outcome)).toBe(2);
  });
});

describe('@no-llm taskOutcomeForReplay (FEAT-054)', () => {
  it.each([
    [{ kind: 'success', runId: 'r', outputs: {} }, 'fulfilled', 0],
    [{ kind: 'aborted', runId: 'r', reason: 'user-handoff' }, 'handoff', 4],
    [{ kind: 'aborted', runId: 'r', reason: 'user-abort' }, 'aborted', 130],
    [{ kind: 'aborted', runId: 'r', reason: 'scope-violation' }, 'failed', 2],
    [{ kind: 'aborted', runId: 'r', reason: 'ethics-refused' }, 'failed', 2],
    [
      {
        kind: 'failure',
        runId: 'r',
        failureClass: 'locator_not_found',
        failureDetail: { stepId: 's1', message: 'missing' },
      },
      'failed',
      2,
    ],
  ] as const)('maps %o to %s with exit code %i', (outcome, word, exit) => {
    const typed = outcome as unknown as Parameters<typeof taskOutcomeForReplay>[0];
    expect(taskOutcomeForReplay(typed)).toBe(word);
    expect(exitCodeFor(typed)).toBe(exit);
  });
});

describe('one outcome table for run and the agentic commands (REV-011)', () => {
  const outcomes: readonly OrchestratorRunOutcome[] = [
    { kind: 'success', runId: 'r', outputs: {} },
    { kind: 'aborted', runId: 'r', reason: 'user-handoff' },
    { kind: 'aborted', runId: 'r', reason: 'user-abort' },
    { kind: 'aborted', runId: 'r', reason: 'scope-violation' },
    { kind: 'aborted', runId: 'r', reason: 'ethics-refused' },
  ];

  it.each(outcomes)(
    '$kind/$reason exits with the code the shared table gives its word',
    (outcome) => {
      const word: TaskOutcome = taskOutcomeForReplay(outcome);
      expect(exitCodeFor(outcome)).toBe(TASK_OUTCOME_TABLE[word].exitCode);
    },
  );

  it('keeps one exit code per word', () => {
    expect(
      Object.fromEntries(
        Object.entries(TASK_OUTCOME_TABLE).map(([word, mapping]) => [word, mapping.exitCode]),
      ),
    ).toEqual({ fulfilled: 0, partial: 2, handoff: 4, failed: 2, aborted: 130 });
  });
});
