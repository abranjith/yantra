import { type FailureClass, TaskOutcome, type TerminationReason } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  TASK_OUTCOME_TABLE,
  exitCodeForAgenticOutcome,
  failureClassFor,
  outcomeFirstLine,
  outcomeSummary,
  taskOutcomeOf,
  type AgenticTaskOutcome,
  type RequirementsSummary,
} from '../../src/runtime/outcome.js';

const brief = {
  kind: 'brief' as const,
  briefId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  jsonPath: '/runs/r/brief.json',
  markdownPath: '/runs/r/brief.md',
  htmlPath: '/runs/r/brief.html',
};
const base = { runId: 'r', runDir: '/runs/r' };
const error = { code: 'AGENT_TOOL_FAILED', message: 'boom' };

function published(
  taskOutcome: 'fulfilled' | 'partial',
  requirements: RequirementsSummary | null,
  terminationReason: TerminationReason = 'model_finished',
): Extract<AgenticTaskOutcome, { kind: 'published' }> {
  return { ...base, kind: 'published', brief, taskOutcome, requirements, terminationReason };
}

const unmet = (n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: index === 0 ? 'artifact:screenshot:viewport' : index === 1 ? 'fill' : `filter:f${index}`,
    label:
      index === 0
        ? 'viewport screenshot'
        : index === 1
          ? 'fill all eligible fields'
          : `f${index} = x`,
    reason: index === 0 ? 'not captured' : index === 1 ? 'fields 10 of 48 filled' : 'not confirmed',
  }));

describe('@no-llm task outcome mapping table (FEAT-054 D3)', () => {
  it('has one row per outcome word with the documented exit code, status, and event', () => {
    expect(Object.keys(TASK_OUTCOME_TABLE).sort()).toEqual([...TaskOutcome.options].sort());
    expect(TASK_OUTCOME_TABLE).toEqual({
      fulfilled: { exitCode: 0, manifestStatus: 'completed', event: 'task_completed' },
      partial: { exitCode: 2, manifestStatus: 'failed', event: 'task_failed' },
      handoff: { exitCode: 4, manifestStatus: 'failed', event: 'task_failed' },
      failed: { exitCode: 2, manifestStatus: 'failed', event: 'task_failed' },
      aborted: { exitCode: 130, manifestStatus: 'aborted', event: 'task_failed' },
    });
  });

  const cases: readonly [
    string,
    AgenticTaskOutcome,
    TaskOutcome,
    number,
    FailureClass | undefined,
  ][] = [
    [
      'fulfilled do',
      published('fulfilled', { met: 3, total: 3, unmet: [], contractDeclared: true }),
      'fulfilled',
      0,
      undefined,
    ],
    ['fulfilled research', published('fulfilled', null), 'fulfilled', 0, undefined],
    [
      'partial after the soft boundary',
      published(
        'partial',
        { met: 1, total: 3, unmet: unmet(2), contractDeclared: true },
        'wall-clock-soft',
      ),
      'partial',
      2,
      'budget_exhausted',
    ],
    [
      'partial after the hard deadline',
      published(
        'partial',
        { met: 1, total: 3, unmet: unmet(2), contractDeclared: true },
        'wall-clock-hard',
      ),
      'partial',
      2,
      'budget_exhausted',
    ],
    [
      'partial after the token budget',
      published('partial', null, 'provider-tokens'),
      'partial',
      2,
      'budget_exhausted',
    ],
    [
      'partial after the tool budget',
      published('partial', null, 'tool-budget'),
      'partial',
      2,
      'budget_exhausted',
    ],
    [
      'partial when the model finished',
      published('partial', { met: 1, total: 3, unmet: unmet(2), contractDeclared: true }),
      'partial',
      2,
      'requirements_unmet',
    ],
    [
      'partial after the stuck-loop breaker',
      published('partial', null, 'repeated-tool-failure'),
      'partial',
      2,
      'requirements_unmet',
    ],
    [
      'captcha handoff',
      {
        ...base,
        kind: 'handoff',
        blocker: 'A CAPTCHA blocked the page.',
        safestNextAction: 'Solve it.',
        terminationReason: 'handoff',
      },
      'handoff',
      4,
      'captcha_detected',
    ],
    [
      'MFA handoff',
      {
        ...base,
        kind: 'handoff',
        blocker: 'The site asked for a two-factor code.',
        safestNextAction: 'Sign in.',
        terminationReason: 'handoff',
      },
      'handoff',
      4,
      'mfa_required',
    ],
    [
      'other handoff',
      {
        ...base,
        kind: 'handoff',
        blocker: 'Location is needed.',
        safestNextAction: 'Grant it.',
        terminationReason: 'handoff',
      },
      'handoff',
      4,
      'unexpected',
    ],
    [
      'missing completion',
      {
        ...base,
        kind: 'failed',
        error: { code: 'AGENT_COMPLETION_MISSING', message: 'none' },
        terminationReason: 'model_finished',
      },
      'failed',
      2,
      'validation_error',
    ],
    [
      'provider failure',
      { ...base, kind: 'failed', error, terminationReason: 'provider_failed' },
      'failed',
      2,
      'unexpected',
    ],
    [
      'budget exhausted',
      { ...base, kind: 'budget_exhausted', error, terminationReason: 'tool-budget' },
      'failed',
      2,
      'budget_exhausted',
    ],
    [
      'user abort',
      { ...base, kind: 'aborted', error, terminationReason: 'user_abort' },
      'aborted',
      130,
      'user_aborted',
    ],
  ];

  it.each(cases)('maps %s', (_label, outcome, word, exit, failureClass) => {
    expect(taskOutcomeOf(outcome)).toBe(word);
    expect(exitCodeForAgenticOutcome(outcome)).toBe(exit);
    expect(exitCodeForAgenticOutcome(outcome)).toBe(TASK_OUTCOME_TABLE[word].exitCode);
    expect(failureClassFor(outcome)).toBe(failureClass);
  });
});

describe('@no-llm outcomeFirstLine', () => {
  it('reads fulfilled with its count for do', () => {
    expect(
      outcomeFirstLine(
        published('fulfilled', { met: 3, total: 3, unmet: [], contractDeclared: true }),
      ),
    ).toBe('Fulfilled: 3 of 3 requirements met. Brief: /runs/r/brief.html');
  });

  it('reads fulfilled without a count for ask and research', () => {
    expect(outcomeFirstLine(published('fulfilled', null))).toBe(
      'Fulfilled. Brief: /runs/r/brief.html',
    );
  });

  it('names at most two unmet items, then +N more', () => {
    expect(
      outcomeFirstLine(
        published('partial', { met: 1, total: 3, unmet: unmet(2), contractDeclared: true }),
      ),
    ).toBe(
      'Partial: 1 of 3 requirements met; viewport screenshot not captured; fields 10 of 48 filled. Brief: /runs/r/brief.html',
    );
    expect(
      outcomeFirstLine(
        published('partial', { met: 0, total: 5, unmet: unmet(5), contractDeclared: true }),
      ),
    ).toBe(
      'Partial: 0 of 5 requirements met; viewport screenshot not captured; fields 10 of 48 filled; +3 more. Brief: /runs/r/brief.html',
    );
  });

  it('says when no contract was declared', () => {
    expect(
      outcomeFirstLine(
        published('partial', { met: 0, total: 0, unmet: [], contractDeclared: false }),
      ),
    ).toBe('Partial: no task contract was declared. Brief: /runs/r/brief.html');
  });

  it('says report for a templated run and accepts a run-relative path', () => {
    const templated = {
      ...published('fulfilled', null),
      brief: { ...brief, kind: 'templated_report' as const },
    };
    expect(outcomeFirstLine(templated)).toBe('Fulfilled. report: /runs/r/brief.html');
    expect(outcomeFirstLine(published('fulfilled', null), 'brief.html')).toBe(
      'Fulfilled. Brief: brief.html',
    );
  });

  it('bounds the summary to 240 characters before the path', () => {
    const long = Array.from({ length: 2 }, (_, index) => ({
      id: `filter:f${index}`,
      label: 'x'.repeat(120),
      reason: 'y'.repeat(200),
    }));
    const summary = outcomeSummary(
      published('partial', { met: 0, total: 2, unmet: long, contractDeclared: true }),
    );
    expect(summary.length).toBe(240);
    expect(summary.endsWith('…')).toBe(true);
  });
});
