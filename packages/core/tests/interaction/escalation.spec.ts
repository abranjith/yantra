/** @no-llm declarative escalation runner contracts. */

import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  SERIALIZED_EVIDENCE_KEYS,
  createRunState,
  escalationLedgerOf,
  normalizeAttemptArtifact,
  runEscalationPlan,
  runStatePort,
  toWireLedger,
  type EscalationPlan,
  type Rung,
  type RungVerdict,
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

  it('emits discriminated wire keys and still reads the legacy shape back', async () => {
    const run = await runEscalationPlan(
      makePlan([
        rung('overtype', async () => ({ ok: false, failure: failure('STALE_ELEMENT_REF') })),
        rung('retry', async () => ({ ok: true, value: 'done' })),
      ]),
    );
    const wire = toWireLedger(run.ledger);
    expect(wire[0]).toHaveProperty('error_code', 'STALE_ELEMENT_REF');
    // A successful record has no `error_code` key at all, asserted on presence
    // rather than on value: `null` was the artifact the schema meant to remove.
    expect(wire[1]).not.toHaveProperty('error_code');
    expect(wire.map((record) => record.strategy)).toEqual(['overtype', 'retry']);
    // Still total over the legacy producer's own shape.
    expect(
      normalizeAttemptArtifact([
        { attempt: 1, strategy: 'overtype', axis: 'how', errorCode: 'STALE_ELEMENT_REF' },
        { attempt: 2, strategy: 'retry', axis: 'how', errorCode: null },
      ]).map((entry) => entry.kind),
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

  it('charges one mutation when a wrapped port is re-wrapped for the same run', async () => {
    const counter = countingPort();
    const state = createRunState(budget(), 0);
    const once = runStatePort(counter.port, state);
    const twice = runStatePort(once, state);

    await twice.fill('e1', 'value');

    expect(twice).toBe(once);
    expect(counter.fills).toBe(1);
    expect(state.chargedActions).toBe(1);
  });

  it('charges one mutation through three levels of nesting on the same run', async () => {
    // Every nested call site hands its own `context.port` down. Charging per
    // wrapper rather than per run is what turned one `fill` into three.
    const counter = countingPort();
    const plan = makePlan(
      [
        rung('grandparent', async (context) =>
          context
            .runSubplan(
              makePlan(
                [
                  rung('parent', async (inner) =>
                    inner
                      .runSubplan(
                        makePlan(
                          [
                            rung('child', async (deepest) => {
                              await deepest.port.fill('e1', 'value');
                              return { ok: true, value: 'child' };
                            }),
                          ],
                          inner.port,
                        ),
                      )
                      .then(() => ({ ok: true as const, value: 'parent' })),
                  ),
                ],
                context.port,
              ),
            )
            .then(() => ({ ok: true as const, value: 'grandparent' })),
        ),
      ],
      counter.port,
    );

    const run = await runEscalationPlan(plan);

    expect(counter.fills).toBe(1);
    expect(run.ledger.chargedActions).toBe(1);
    expect(chargesOf(run.ledger.verdicts)).toEqual([1, 0, 0]);
  });

  it('charges both wrappers when the same port is wrapped for two different runs', async () => {
    const port = countingPort();
    const first = createRunState(budget(), 0);
    const second = createRunState(budget(), 0);

    const wrapped = runStatePort(port.port, first);
    await runStatePort(wrapped, second).fill('e1', 'value');

    expect(port.fills).toBe(1);
    expect(first.chargedActions).toBe(1);
    expect(second.chargedActions).toBe(1);
  });

  it('reports per-rung cost exclusive of nested work, partitioning the run total', async () => {
    const port = fakePort();
    const parent = makePlan(
      [
        rung('parent', async (context) => {
          await context.port.fill('e1', 'value');
          await context.runSubplan(
            makePlan(
              [
                rung('child', async ({ port: live }) => {
                  await live.press('Enter');
                  await live.press('Tab');
                  return { ok: true, value: 'child' };
                }),
              ],
              context.port,
            ),
          );
          await context.port.click('e1');
          return { ok: true, value: 'parent' };
        }),
      ],
      port,
    );

    const run = await runEscalationPlan(parent);

    expect(chargesOf(run.ledger.verdicts)).toEqual([2, 2]);
    expect(sumCharges(run.ledger.verdicts)).toBe(run.ledger.chargedActions);
    expect(run.ledger.chargedActions).toBe(4);
  });

  it('never increases remaining actions across two nesting levels', async () => {
    const port = fakePort();
    const plan = makePlan(
      [
        rung('grandparent', async (context) => {
          await context.port.fill('e1', 'a');
          await context.runSubplan(
            makePlan(
              [
                rung('parent', async (inner) => {
                  await inner.port.press('Enter');
                  await inner.runSubplan(
                    makePlan(
                      [
                        rung('child', async (deepest) => {
                          await deepest.port.press('Tab');
                          return { ok: true, value: 'child' };
                        }),
                      ],
                      inner.port,
                    ),
                  );
                  return { ok: true, value: 'parent' };
                }),
              ],
              context.port,
            ),
          );
          return { ok: true, value: 'grandparent' };
        }),
      ],
      port,
    );

    const run = await runEscalationPlan(plan);
    const remaining = run.ledger.verdicts.flatMap((verdict) =>
      verdict.kind === 'skipped' ? [] : [verdict.remainingActions],
    );

    expect(run.ledger.verdicts.map((verdict) => verdict.rungId)).toEqual([
      'child',
      'parent',
      'grandparent',
    ]);
    expect(remaining).toEqual([...remaining].sort((left, right) => right - left));
    expect(sumCharges(run.ledger.verdicts)).toBe(run.ledger.chargedActions);
  });

  it('returns only its own verdicts from a nested run while reporting the shared remainder', async () => {
    const port = fakePort();
    let nested: Awaited<ReturnType<typeof runEscalationPlan>> | null = null;
    const plan = makePlan(
      [
        rung('parent', async (context) => {
          await context.port.fill('e1', 'a');
          nested = await context.runSubplan(
            makePlan(
              [
                rung('child', async ({ port: live }) => {
                  await live.press('Enter');
                  return { ok: true, value: 'child' };
                }),
              ],
              context.port,
            ),
          );
          return { ok: true, value: 'parent' };
        }),
      ],
      port,
    );

    const run = await runEscalationPlan(plan);
    const child = nested!;

    expect(child.ledger.verdicts.map((verdict) => verdict.rungId)).toEqual(['child']);
    expect(child.ledger.chargedActions).toBe(2);
    expect(child.ledger.remainingActions).toBe(6);
    expect(run.ledger.verdicts.map((verdict) => verdict.rungId)).toEqual(['child', 'parent']);
  });

  it('joins the run carried on the budget without moving the ceiling it declares', async () => {
    const port = fakePort();
    const state = createRunState({ deadlineMs: 1_000, maxActions: 8, maxReacquisitions: 4 }, 0);
    state.verdicts.push(existingVerdict());
    const joined: EscalationPlan<string, Failure, WidgetPort> = {
      ...makePlan([rung('joined', async () => ({ ok: true, value: 'joined' }))], port),
      budget: {
        deadlineMs: 5_000,
        maxActions: 99,
        maxPagingSteps: 2,
        maxReacquisitions: 9,
        run: state,
      },
    };

    const run = await runEscalationPlan(joined);

    expect(state.maxActions).toBe(8);
    expect(state.maxReacquisitions).toBe(4);
    expect(state.verdicts.map((verdict) => verdict.rungId)).toEqual(['already-run', 'joined']);
    expect(state.verdicts.map((verdict) => verdict.ordinal)).toEqual([1, 2]);
    // The plan reports its own slice; the run owner projects the whole sequence.
    expect(run.ledger.verdicts.map((verdict) => verdict.rungId)).toEqual(['joined']);
    expect(
      escalationLedgerOf(state, { operation: 'fill-field', family: 'field' }).verdicts.map(
        (verdict) => verdict.rungId,
      ),
    ).toEqual(['already-run', 'joined']);
  });

  it('caps re-acquisition once per run, however many sub-plans ask to heal', async () => {
    const tried: string[] = [];
    const asked: string[] = [];
    const port: WidgetPort = {
      ...fakePort(),
      fill: async (ref) => {
        tried.push(ref);
        throw staleRefError();
      },
    };
    let minted = 1;
    const subplan = (parentPort: WidgetPort): EscalationPlan<string, Failure, WidgetPort> => ({
      ...makePlan(
        [
          rung('nested', async ({ port: live }) => {
            await live.fill('e1', 'value');
            return { ok: true, value: 'nested' };
          }),
        ],
        parentPort,
      ),
      // Declared per sub-plan; installed on the run exactly once, by the first.
      reacquire: async (current) => {
        asked.push(current);
        minted += 1;
        return `e${minted}`;
      },
    });
    const root: EscalationPlan<string, Failure, WidgetPort> = {
      ...makePlan(
        [
          rung('root', async (context) => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
              await context.runSubplan(subplan(context.port)).catch(() => undefined);
            }
            return { ok: true, value: 'root' };
          }),
        ],
        port,
      ),
      budget: { deadlineMs: 1_000, maxActions: 8, maxPagingSteps: 2, maxReacquisitions: 2 },
    };

    const run = await runEscalationPlan(root);

    // Two heals granted across three sub-plans; the third is refused outright,
    // so it never even asks.
    expect(asked).toEqual(['e1', 'e2']);
    expect(tried).toEqual(['e1', 'e2', 'e2', 'e3', 'e3']);
    expect(run.ledger.verdicts.filter((verdict) => verdict.kind !== 'skipped')).not.toHaveLength(0);
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

/** The keys a verdict contributes itself, before any rung evidence. */
const FIXED_VERDICT_KEYS: ReadonlySet<string> = new Set([
  'ordinal',
  'strategy',
  'axis',
  'verdict',
  'entry_evidence',
  'charged_actions',
  'remaining_actions',
  'elapsed_ms',
  'error_code',
  'detail',
  'unmet',
]);

describe('@no-llm serialized rung evidence is an allowlist', () => {
  const wireFor = async (evidence: Readonly<Record<string, unknown>>) => {
    const run = await runEscalationPlan(
      makePlan([
        {
          ...rung('discloses', async () => ({ ok: true, value: 'done', evidence })),
          produces: [...Object.keys(evidence)],
        },
      ]),
    );
    return toWireLedger(run.ledger)[0]!;
  };

  it('never lets a rung\u2019s working values reach the wire', async () => {
    // Without the allowlist, switching the fill path to this projection would
    // spread `committed`, `offered`, `chosen`, `editee` and a container **path
    // object** into every successful record — unbounded page-derived data in a
    // field that carries counts and structural tokens only.
    const record = await wireFor({
      committed: 'Dallas',
      offered: ['Dallas', 'Dallas Love Field'],
      chosen: 'Dallas',
      editee: 'Search airports',
      container: { path: [0, 3, 12], ref: 'e88' },
      scroll_steps: 3,
    });

    expect(record).not.toHaveProperty('committed');
    expect(record).not.toHaveProperty('offered');
    expect(record).not.toHaveProperty('chosen');
    expect(record).not.toHaveProperty('editee');
    expect(record).not.toHaveProperty('container');
    expect(record.scroll_steps).toBe(3);
  });

  it('refuses a non-scalar value even for an allowlisted key', async () => {
    const record = await wireFor({
      scroll_steps: [3],
      scroll_stop: { reason: 'matched' },
      substituted: 2,
    });

    expect(record).not.toHaveProperty('scroll_steps');
    expect(record).not.toHaveProperty('scroll_stop');
    expect(record.substituted).toBe(2);
  });

  it('serializes no object or array value, for any generated evidence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(
          fc.oneof(fc.constantFrom(...SERIALIZED_EVIDENCE_KEYS), fc.string()),
          fc.jsonValue(),
          { maxKeys: 6 },
        ),
        async (evidence) => {
          const record = await wireFor(evidence as Readonly<Record<string, unknown>>);
          // Every key the record did not get from the verdict's own fixed shape
          // came from rung evidence, and none of those may be a structure.
          for (const [key, value] of Object.entries(record)) {
            if (FIXED_VERDICT_KEYS.has(key)) continue;
            expect(SERIALIZED_EVIDENCE_KEYS).toContain(key);
            expect(typeof value === 'object' && value !== null).toBe(false);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});

function budget(): { deadlineMs: number; maxActions: number; maxReacquisitions: number } {
  return { deadlineMs: 1_000, maxActions: 8, maxReacquisitions: 4 };
}

function chargesOf(verdicts: readonly RungVerdict[]): readonly number[] {
  return verdicts.flatMap((verdict) =>
    verdict.kind === 'skipped' ? [] : [verdict.chargedActions],
  );
}

function sumCharges(verdicts: readonly RungVerdict[]): number {
  return chargesOf(verdicts).reduce((total, charge) => total + charge, 0);
}

function existingVerdict(): RungVerdict {
  return { kind: 'skipped', ordinal: 1, rungId: 'already-run', axis: 'how', unmet: 'no-signal' };
}

function staleRefError(): Error & { readonly code: string } {
  return Object.assign(new Error('stale'), { code: 'STALE_ELEMENT_REF' });
}

/** A port that counts what actually reached the page, beneath every wrapper. */
function countingPort(): { readonly port: WidgetPort; readonly fills: number } {
  let fills = 0;
  const port: WidgetPort = {
    ...fakePort(),
    fill: async () => {
      fills += 1;
    },
  };
  return {
    port,
    get fills(): number {
      return fills;
    },
  };
}

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
