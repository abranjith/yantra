// @no-llm
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

  it('returns 4 for user-abort', () => {
    const outcome: OrchestratorRunOutcome = {
      kind: 'aborted',
      runId: 'run-001',
      reason: 'user-abort',
    };
    expect(exitCodeFor(outcome)).toBe(4);
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
    [{ kind: 'aborted', runId: 'r', reason: 'user-abort' }, 'aborted', 4],
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
  ] as const)('maps %o to %s with the unchanged exit code %i', (outcome, word, exit) => {
    const typed = outcome as unknown as Parameters<typeof taskOutcomeForReplay>[0];
    expect(taskOutcomeForReplay(typed)).toBe(word);
    expect(exitCodeFor(typed)).toBe(exit);
  });
});
