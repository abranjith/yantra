/** @no-llm declarative escalation runner contracts. */

import { describe, expect, it, vi } from 'vitest';

import {
  normalizeAttemptArtifact,
  runEscalationPlan,
  toLegacyLedger,
  toWireLedger,
  type EscalationPlan,
  type Rung,
} from '../../src/interaction/escalation.js';
import type { WidgetPort } from '../../src/widgets/types.js';

interface Failure {
  readonly errorCode: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

describe('@no-llm runEscalationPlan', () => {
  it('executes in declared order and records skipped rungs without spending work', async () => {
    const seen: string[] = [];
    const plan = makePlan([
      rung('first', async () => {
        seen.push('first');
        return { ok: false, failure: failure('STALE_ELEMENT_REF') };
      }),
      {
        ...rung('skipped', async () => {
          seen.push('skipped');
          return { ok: true, value: 'impossible' };
        }),
        entry: () => ({ enter: false as const, unmet: 'no-replacement-signal' }),
      },
      rung('last', async () => {
        seen.push('last');
        return { ok: true, value: 'done', evidence: { committed: true } };
      }),
    ]);

    const run = await runEscalationPlan(plan);

    expect(seen).toEqual(['first', 'last']);
    expect(run.outcome).toMatchObject({ ok: true, value: 'done' });
    expect(run.ledger.verdicts.map((entry) => entry.kind)).toEqual([
      'failed',
      'skipped',
      'succeeded',
    ]);
    expect(run.ledger.verdicts[1]).not.toHaveProperty('chargedActions');
    expect(run.ledger.verdicts[2]).not.toHaveProperty('errorCode');
  });

  it('shares budget and ordinals with a sub-plan', async () => {
    const port = fakePort();
    const child = makePlan(
      [
        rung('child', async ({ port: live }) => {
          await live.press('Enter');
          return { ok: true, value: 'child' };
        }),
      ],
      port,
    );
    const parent = makePlan(
      [
        rung('parent', async (context) => {
          await context.port.fill('e1', 'value');
          await context.runSubplan(child);
          return { ok: true, value: 'parent' };
        }),
      ],
      port,
    );

    const run = await runEscalationPlan(parent);

    expect(run.ledger.verdicts.map((entry) => entry.rungId)).toEqual(['child', 'parent']);
    expect(run.ledger.verdicts.map((entry) => entry.ordinal)).toEqual([1, 2]);
    expect(run.ledger.chargedActions).toBe(2);
    expect(run.ledger.remainingActions).toBe(6);
  });

  it('runs cleanup only for entered rungs, including when the body throws', async () => {
    const cleanup = vi.fn(async () => undefined);
    const skippedCleanup = vi.fn(async () => undefined);
    const plan = makePlan([
      {
        ...rung('skipped', async () => ({ ok: true, value: 'no' })),
        entry: () => ({ enter: false as const, unmet: 'control-not-empty' }),
        cleanup: skippedCleanup,
      },
      { ...rung('throws', async () => Promise.reject(new Error('boom'))), cleanup },
    ]);

    await expect(runEscalationPlan(plan)).rejects.toThrow('boom');
    expect(skippedCleanup).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('skips a rung whose declared cost cannot fit the remaining plan budget', async () => {
    const expensive = {
      ...rung('expensive', async () => ({ ok: true, value: 'no' })),
      costCap: { maxActions: 9 },
    };
    const run = await runEscalationPlan(makePlan([expensive]));
    expect(run.outcome).toBeNull();
    expect(run.ledger.verdicts).toEqual([
      expect.objectContaining({ kind: 'skipped', unmet: 'insufficient-remaining-budget' }),
    ]);
    expect(toWireLedger(run.ledger)[0]).toMatchObject({
      verdict: 'skipped',
      unmet: 'insufficient-remaining-budget',
    });
    expect(toWireLedger(run.ledger)[0]).not.toHaveProperty('error_code');
  });

  it('keeps budget/disabled overrides terminal and unknown failures terminal', async () => {
    const after = vi.fn(async () => ({ ok: true as const, value: 'should-not-run' }));
    for (const first of [
      failure('WIDGET_NOT_COMMITTED', { reason: 'budget' }),
      failure('ELEMENT_HIDDEN', { reason: 'disabled' }),
      failure('UNREGISTERED_CODE'),
    ]) {
      after.mockClear();
      const run = await runEscalationPlan(
        makePlan([
          rung('first', async () => ({ ok: false, failure: first })),
          rung('after', after),
        ]),
      );
      expect(run.ledger.verdicts).toHaveLength(1);
      expect(after).not.toHaveBeenCalled();
    }
  });

  it('projects legacy bytes and discriminated wire keys', async () => {
    const run = await runEscalationPlan(
      makePlan([
        rung('overtype', async () => ({ ok: false, failure: failure('STALE_ELEMENT_REF') })),
        rung('retry', async () => ({ ok: true, value: 'done' })),
      ]),
    );
    expect(toLegacyLedger(run.ledger).records).toEqual([
      expect.objectContaining({ attempt: 1, strategy: 'overtype', errorCode: 'STALE_ELEMENT_REF' }),
      expect.objectContaining({ attempt: 2, strategy: 'retry', errorCode: null }),
    ]);
    const wire = toWireLedger(run.ledger);
    expect(wire[0]).toHaveProperty('error_code', 'STALE_ELEMENT_REF');
    expect(wire[1]).not.toHaveProperty('error_code');
    expect(
      normalizeAttemptArtifact(toLegacyLedger(run.ledger).records).map((entry) => entry.kind),
    ).toEqual(['failed', 'succeeded']);
  });

  it('uses the rung list as the only execution-order authority', async () => {
    const seen: string[] = [];
    const first = rung('first', async () => {
      seen.push('first');
      return { ok: true, value: 'first' };
    });
    const second = rung('second', async () => {
      seen.push('second');
      return { ok: true, value: 'second' };
    });

    await runEscalationPlan(makePlan([second, first]));

    expect(seen).toEqual(['second', 'first']);
  });

  it('fast-fails on the injected clock without starting later rungs', async () => {
    let now = 0;
    const later = vi.fn(async () => ({ ok: true as const, value: 'late' }));
    const plan: EscalationPlan<string, Failure, WidgetPort> = {
      ...makePlan([]),
      rungs: [
        rung('failure', async () => {
          now = 4_000;
          return { ok: false, failure: failure('STALE_ELEMENT_REF') };
        }),
        rung('later', later),
      ],
      budget: { deadlineMs: 4_000, maxActions: 8, maxPagingSteps: 2, maxReacquisitions: 4 },
      now: () => now,
    };

    const run = await runEscalationPlan(plan);

    expect(run.ledger.elapsedMs).toBe(4_000);
    expect(later).not.toHaveBeenCalled();
  });
});

function makePlan(
  rungs: readonly Rung<string, Failure, WidgetPort>[],
  port = fakePort(),
): EscalationPlan<string, Failure, WidgetPort> {
  let now = 0;
  return {
    family: 'text',
    operation: 'test',
    rungs,
    budget: { deadlineMs: 1_000, maxActions: 8, maxPagingSteps: 2, maxReacquisitions: 4 },
    port,
    now: () => now++,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

function rung(
  id: string,
  run: Rung<string, Failure, WidgetPort>['run'],
): Rung<string, Failure, WidgetPort> {
  return {
    id,
    axis: 'how',
    entry: () => ({ enter: true, evidence: [] }),
    costCap: { maxActions: 2 },
    produces: [],
    run,
  };
}

function failure(errorCode: string, details: Readonly<Record<string, unknown>> = {}): Failure {
  return { errorCode, message: errorCode, details };
}

function fakePort(): WidgetPort {
  return {
    observe: async () => ({ url: '', title: '', digest: '', interactables: [] }),
    click: async () => undefined,
    fill: async () => undefined,
    clear: async () => undefined,
    type: async () => undefined,
    evaluateOn: async <T>() => undefined as T,
    evaluate: async <T>() => undefined as T,
    press: async () => undefined,
    scrollContainer: async () => null,
    now: () => 0,
  };
}
