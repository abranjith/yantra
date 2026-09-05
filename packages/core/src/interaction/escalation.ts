/** Declarative recovery plans and their single execution/accounting owner. */

import type { WidgetBudget, WidgetPort } from '../widgets/types.js';

import type { AttemptDisposition, InteractionAxis, InteractionFailureCause } from './types.js';

const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'WIDGET_ELEMENT_REPLACED',
  'STALE_ELEMENT_REF',
  'ELEMENT_HIDDEN',
  'WIDGET_DID_NOT_OPEN',
  'WIDGET_NOT_COMMITTED',
]);

const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'WIDGET_AMBIGUOUS_CHOICE',
  'WIDGET_MAPPING_UNSAFE',
  'WIDGET_RANGE_INCOMPLETE',
  'WIDGET_TARGET_UNREACHABLE',
  'WIDGET_NOT_RECOGNIZED',
  'WIDGET_DISMISS_FAILED',
  'FILL_VALUE_INVALID',
  'SECRET_HOST_MISMATCH',
  'SECRET_RESOLVER_UNAVAILABLE',
  'ELEMENT_DISABLED',
  'OPTION_NOT_FOUND',
  'FORM_FIELD_NOT_FOUND',
  'FORM_FIELD_AMBIGUOUS',
  'BROWSER_UNAVAILABLE',
  'BROWSER_NOT_STARTED',
  'URL_NOT_FROM_EVIDENCE',
  'BUDGET_EXHAUSTED',
  'ELEMENT_OBSTRUCTED',
]);

/** Classify a typed interaction failure; unknown codes fail closed. */
export function classifyFailure(
  errorCode: string,
  details: Readonly<Record<string, unknown>> = {},
): AttemptDisposition {
  const reason = details.reason;
  if (reason === 'budget' || reason === 'disabled') return 'terminal';
  if (errorCode === 'ELEMENT_OBSTRUCTED') {
    return details.kind === 'busy-indicator' ? 'transient' : 'terminal';
  }
  if (TERMINAL_CODES.has(errorCode)) return 'terminal';
  if (TRANSIENT_CODES.has(errorCode)) return 'transient';
  return 'terminal';
}

/** The six recovery policies owned by the interaction layer. */
export type InteractionFamily = 'text' | 'combobox' | 'date' | 'option' | 'field' | 'click';

/** One allowance shared by a plan and every sub-plan it invokes. */
export interface PlanBudget {
  readonly deadlineMs: number;
  readonly maxActions: number;
  readonly maxPagingSteps: number;
  readonly maxReacquisitions: number;
  readonly maxScrollSteps?: number;
  /**
   * The run this plan joins, when it is not the root of one.
   *
   * Absent means "create the state and own it". It rides on the budget rather
   * than on every driver signature because the budget already flows unchanged
   * from `fillField` through `WidgetDriver.drive` and `commitText` into every
   * plan builder — so threading the run changes no public signature and stays
   * explicit data rather than an ambient lookup. A joined plan's own
   * `maxActions`, `deadlineMs` and `maxReacquisitions` never widen or narrow
   * the ceiling the root set.
   */
  readonly run?: MutableRunState;
}

/** The maximum work a rung declares before it may be entered. */
export interface RungCost {
  readonly maxActions: number;
  readonly maxElapsedMs?: number;
}

/** The runner's live, immutable budget projection. */
export interface BudgetState {
  readonly deadlineMs: number;
  readonly remainingActions: number;
  readonly remainingMs: number;
  readonly chargedActions: number;
  readonly chargedReads: number;
  readonly reacquisitions: number;
}

/** Evidence accumulated only from already-executed rungs. */
export interface RungEvidence {
  readonly values: Readonly<Record<string, unknown>>;
  readonly verdicts: readonly RungVerdict[];
  readonly lastOutcome: unknown;
  readonly lastFailure: unknown;
}

/** Pure eligibility decision made before a rung can spend work. */
export type EntryDecision =
  | { readonly enter: true; readonly evidence: readonly string[] }
  | { readonly enter: false; readonly unmet: string };

/** What a rung returned to the runner. */
export type RungOutcome<TValue, TFailure> =
  | {
      readonly ok: true;
      readonly value: TValue;
      readonly evidence?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly failure: TFailure;
      readonly evidence?: Readonly<Record<string, unknown>>;
    };

/** Shared execution state supplied to a rung body. */
export interface RungContext<TPort> {
  readonly port: TPort;
  readonly evidence: RungEvidence;
  readonly budget: BudgetState;
  /** Charge an agent-side action that does not travel through a WidgetPort. */
  readonly charge: (actions?: number) => void;
  /** Execute nested recovery inline on this plan's budget and ledger. */
  readonly runSubplan: <TSubValue, TSubFailure, TSubPort>(
    plan: EscalationPlan<TSubValue, TSubFailure, TSubPort>,
  ) => Promise<EscalationRun<TSubValue, TSubFailure>>;
}

/** One ordered recovery step. */
export interface Rung<TValue, TFailure, TPort> {
  readonly id: string;
  readonly axis: InteractionAxis;
  readonly entry: (evidence: RungEvidence, budget: BudgetState) => EntryDecision;
  readonly costCap: RungCost;
  readonly produces: readonly string[];
  readonly run: (context: RungContext<TPort>) => Promise<RungOutcome<TValue, TFailure>>;
  readonly cleanup?: (context: RungContext<TPort>) => Promise<void>;
  readonly backoffMs?: number;
  readonly terminalOn?: readonly string[];
}

/** An inspectable recovery policy. Reordering `rungs` reorders execution. */
export interface EscalationPlan<TValue, TFailure, TPort = WidgetPort> {
  readonly family: InteractionFamily;
  readonly operation: string;
  readonly rungs: readonly Rung<TValue, TFailure, TPort>[];
  readonly budget: PlanBudget;
  readonly port: TPort;
  readonly now: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly reacquire?: (ref: string) => Promise<string | null>;
  readonly classify?: (failure: TFailure) => AttemptDisposition;
  /** Phase-two compatibility switch; omitted/true activates cap admission. */
  readonly enforceBudgetCaps?: boolean;
}

/**
 * What a rung discloses about **how** it resolved, as counts and structural
 * tokens.
 *
 * Scalars only, by type: a container path or a raw candidate list must not be
 * able to reach the wire through this, and a value that is an object or an
 * array is refused rather than serialized.
 */
export type VerdictEvidence = Readonly<Record<string, string | number | boolean>>;

/**
 * The evidence keys that may be serialized into `details.attempted[]`.
 *
 * An allowlist, in the spirit of `MAX_OFFERED` and `MAX_RANKED_OFFERED`: rung
 * evidence also carries working values — `committed`, `offered`, `chosen`,
 * `editee`, a `container` path — and spreading it blindly would put unbounded
 * page-derived data in a field that carries counts and structural tokens only.
 */
export const SERIALIZED_EVIDENCE_KEYS: readonly string[] = [
  /** How many candidates were indistinguishable to the model. */
  'substituted',
  /** 1-based document-order position taken among them. */
  'substitution_position',
  /** Comma-joined rung names that narrowed the pool. */
  'tie_break',
  /** Bounded container-scroll count. */
  'scroll_steps',
  /** Fixed stop-reason token. */
  'scroll_stop',
  /** Registry driver **kind** revealed by opening. Never page text. */
  'revealed_driver',
  /** Stale-ref healings charged to this rung. */
  'reacquisitions',
];

const SERIALIZED_EVIDENCE: ReadonlySet<string> = new Set(SERIALIZED_EVIDENCE_KEYS);

/** Project rung evidence down to the allowlisted scalars, dropping the rest. */
function serializedEvidence(evidence: Readonly<Record<string, unknown>>): VerdictEvidence {
  const projected: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(evidence)) {
    if (!SERIALIZED_EVIDENCE.has(key)) continue;
    const value = evidence[key];
    if (typeof value === 'string' || typeof value === 'boolean') projected[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) projected[key] = value;
  }
  return projected;
}

interface VerdictBase {
  readonly ordinal: number;
  readonly rungId: string;
  readonly axis: InteractionAxis;
}

/** One discriminated projection of an executed or skipped rung. */
export type RungVerdict =
  | (VerdictBase & {
      readonly kind: 'succeeded';
      readonly entryEvidence: readonly string[];
      readonly chargedActions: number;
      readonly remainingActions: number;
      readonly elapsedMs: number;
      readonly evidence: Readonly<Record<string, unknown>>;
    })
  | (VerdictBase & {
      readonly kind: 'failed';
      readonly entryEvidence: readonly string[];
      readonly chargedActions: number;
      readonly remainingActions: number;
      readonly elapsedMs: number;
      readonly evidence: Readonly<Record<string, unknown>>;
      readonly errorCode: string;
      readonly cause?: InteractionFailureCause;
      readonly detail?: string;
    })
  | (VerdictBase & {
      readonly kind: 'skipped';
      readonly unmet: string;
    });

/**
 * A verdict read back from an artifact, which may predate the measured fields.
 *
 * Identical to {@link RungVerdict} except that the measured fields are
 * optional: a legacy `AttemptRecord` never carried them, and inventing `[]`,
 * `0` and `0` for them is exactly the noise this projection exists to remove.
 * `RungVerdict` is assignable to this; nothing else is.
 */
export type RungVerdictProjection =
  | (VerdictBase & {
      readonly kind: 'succeeded';
      readonly entryEvidence?: readonly string[];
      readonly chargedActions?: number;
      readonly remainingActions?: number;
      readonly elapsedMs?: number;
      readonly evidence: Readonly<Record<string, unknown>>;
    })
  | (VerdictBase & {
      readonly kind: 'failed';
      readonly entryEvidence?: readonly string[];
      readonly chargedActions?: number;
      readonly remainingActions?: number;
      readonly elapsedMs?: number;
      readonly evidence: Readonly<Record<string, unknown>>;
      readonly errorCode: string;
      readonly cause?: InteractionFailureCause;
      readonly detail?: string;
    })
  | (VerdictBase & {
      readonly kind: 'skipped';
      readonly unmet: string;
    });

/** One record as it is written to `details.attempted[]` and read back. */
export type SerializedVerdict = Readonly<Record<string, unknown>>;

/** The ledger is a projection of the one sequence the runner executed. */
export interface EscalationLedger {
  readonly operation: string;
  readonly family: InteractionFamily;
  readonly verdicts: readonly RungVerdict[];
  readonly chargedActions: number;
  readonly elapsedMs: number;
  readonly remainingActions: number;
}

/** Result of one plan, preserving the last page-produced outcome. */
export interface EscalationRun<TValue, TFailure> {
  readonly outcome: RungOutcome<TValue, TFailure> | null;
  readonly ledger: EscalationLedger;
}

/**
 * Everything one top-level call has spent, and the one sequence it produced.
 *
 * Exactly one instance exists per top-level operation. `deadlineMs`,
 * `maxActions` and `maxReacquisitions` are set once by whoever created it and
 * are read-only thereafter, which is what makes the ceiling real across nesting
 * instead of restarting at every sub-plan.
 */
export interface MutableRunState {
  readonly startedAt: number;
  readonly deadlineMs: number;
  readonly maxActions: number;
  readonly maxReacquisitions: number;
  readonly verdicts: RungVerdict[];
  readonly values: Record<string, unknown>;
  chargedActions: number;
  chargedReads: number;
  reacquisitions: number;
  /**
   * How this run finds an owned node the page replaced, or `null`.
   *
   * Installed by whoever owns the run — the fill engine for its field, or the
   * first plan that declares `reacquire` — and read at call time, so a port
   * wrapped before the policy existed still heals through it. Returning `null`
   * both ends healing for an unrecoverable node and is how a caller declines a
   * ref it does not own.
   */
  reacquire: ((currentRef: string) => Promise<string | null>) | null;
  lastOutcome: unknown;
  lastFailure: unknown;
  lastNow: number;
}

/**
 * Start one run. The single constructor of a root {@link MutableRunState}.
 *
 * Callers that own a whole operation — the fill engine, the runner when a plan
 * arrives without a run — create the state here so "how much has this call
 * spent" has exactly one answer.
 */
export function createRunState(
  budget: Pick<PlanBudget, 'deadlineMs' | 'maxActions' | 'maxReacquisitions'>,
  now: number,
): MutableRunState {
  return {
    startedAt: now,
    deadlineMs: budget.deadlineMs,
    maxActions: Math.max(0, Math.floor(budget.maxActions)),
    maxReacquisitions: Math.max(0, Math.floor(budget.maxReacquisitions)),
    verdicts: [],
    values: {},
    chargedActions: 0,
    chargedReads: 0,
    reacquisitions: 0,
    reacquire: null,
    lastOutcome: null,
    lastFailure: null,
    lastNow: now,
  };
}

/** Stale-ref healings one whole call may charge. Shared, never per wrapper. */
export const DEFAULT_MAX_REACQUISITIONS = 4;

/**
 * Convert the established widget allowance into the runner-owned shape.
 *
 * The run rides through unchanged: a plan built from a budget that already
 * carries one joins that run instead of opening a fresh ceiling, a fresh
 * re-acquisition cap and a fresh ledger.
 */
export function asPlanBudget(budget: WidgetBudget): PlanBudget {
  return {
    deadlineMs: budget.deadlineMs,
    maxActions: budget.maxActions,
    maxPagingSteps: budget.maxPagingSteps ?? 12,
    maxReacquisitions: DEFAULT_MAX_REACQUISITIONS,
    maxScrollSteps: budget.maxScrollSteps ?? 8,
    ...(budget.run === undefined ? {} : { run: budget.run }),
  };
}

/** Project the complete sequence a run has executed so far. */
export function escalationLedgerOf(
  state: MutableRunState,
  descriptor: { readonly operation: string; readonly family: InteractionFamily },
): EscalationLedger {
  return {
    operation: descriptor.operation,
    family: descriptor.family,
    verdicts: [...state.verdicts],
    chargedActions: state.chargedActions,
    elapsedMs: state.lastNow - state.startedAt,
    remainingActions: Math.max(0, state.maxActions - state.chargedActions),
  };
}

/**
 * Execute one declarative plan. This is the only recovery loop in production.
 *
 * A nested plan receives the same mutable state, so its verdicts, deadline,
 * action ceiling, and ordinals are shared rather than merged afterwards.
 */
export async function runEscalationPlan<TValue, TFailure, TPort>(
  plan: EscalationPlan<TValue, TFailure, TPort>,
  parentState?: MutableRunState,
): Promise<EscalationRun<TValue, TFailure>> {
  assertPlanShape(plan);
  // A parent state passed directly, a run carried on the budget, or none —
  // in which case this plan is the root and owns the state it creates.
  const adopted = parentState ?? plan.budget.run;
  const initialNow = adopted?.lastNow ?? plan.now();
  const state: MutableRunState = adopted ?? createRunState(plan.budget, initialNow);
  // Where this plan's own slice of the shared sequence begins. A joined plan
  // returns only the verdicts it appended, while its budget figures continue to
  // describe the whole run.
  const verdictsAtEntry = state.verdicts.length;
  let outcome: RungOutcome<TValue, TFailure> | null = null;

  for (const rung of plan.rungs) {
    const checkedAt = plan.now();
    state.lastNow = checkedAt;
    const evidence = evidenceOf(state);
    const budget = budgetOf(state, checkedAt);
    const decision = rung.entry(evidence, budget);
    const budgetUnmet = budgetDecision(rung.costCap, budget, plan.enforceBudgetCaps !== false);
    if (!decision.enter || budgetUnmet !== null) {
      state.verdicts.push({
        kind: 'skipped',
        ordinal: state.verdicts.length + 1,
        rungId: rung.id,
        axis: rung.axis,
        unmet: decision.enter ? budgetUnmet! : decision.unmet,
      });
      continue;
    }

    const pause = Math.max(0, rung.backoffMs ?? 0);
    if (pause > 0) {
      if (plan.now() + pause >= state.deadlineMs) {
        state.verdicts.push({
          kind: 'skipped',
          ordinal: state.verdicts.length + 1,
          rungId: rung.id,
          axis: rung.axis,
          unmet: 'deadline-expired',
        });
        continue;
      }
      await (plan.sleep ?? realSleep)(pause);
    }

    const startedAt = checkedAt;
    const actionsBefore = state.chargedActions;
    const readsBefore = state.chargedReads;
    const nestedVerdictsBefore = state.verdicts.length;
    const port = wrapPort(plan.port, plan, state);
    const context: RungContext<TPort> = {
      port,
      evidence,
      budget,
      charge: (actions = 1) => {
        state.chargedActions += Math.max(0, Math.floor(actions));
      },
      runSubplan: (subplan) => runEscalationPlan(subplan, state),
    };
    try {
      outcome = await rung.run(context);
      state.lastOutcome = outcome;
      // Exclusive of nested work: whatever a sub-plan's rungs already claimed
      // belongs to them, so summing the ledger partitions the run total exactly
      // instead of counting the children again inside the parent.
      const chargedActions =
        state.chargedActions - actionsBefore - chargesSince(state, nestedVerdictsBefore);
      const endedAt = plan.now();
      state.lastNow = endedAt;
      const elapsedMs = endedAt - startedAt;
      if (outcome.evidence) Object.assign(state.values, outcome.evidence);
      if (outcome.ok) {
        state.lastFailure = null;
        state.verdicts.push({
          kind: 'succeeded',
          ordinal: state.verdicts.length + 1,
          rungId: rung.id,
          axis: rung.axis,
          entryEvidence: [...decision.evidence],
          chargedActions,
          remainingActions: Math.max(0, state.maxActions - state.chargedActions),
          elapsedMs,
          evidence: outcome.evidence ?? {},
        });
        continue;
      }

      state.lastFailure = outcome.failure;
      const described = describeFailure(outcome.failure);
      state.verdicts.push({
        kind: 'failed',
        ordinal: state.verdicts.length + 1,
        rungId: rung.id,
        axis: rung.axis,
        entryEvidence: [...decision.evidence],
        chargedActions,
        remainingActions: Math.max(0, state.maxActions - state.chargedActions),
        elapsedMs,
        evidence: outcome.evidence ?? {},
        errorCode: described.errorCode,
        ...(described.cause === undefined ? {} : { cause: described.cause }),
        ...(described.detail === undefined ? {} : { detail: described.detail }),
      });
      const disposition =
        plan.classify?.(outcome.failure) ?? classifyFailure(described.errorCode, described.details);
      if (rung.terminalOn?.includes(described.errorCode) || disposition === 'terminal') break;
      if (endedAt >= state.deadlineMs) break;
    } finally {
      // The reads delta is intentionally tracked even though only action cost is
      // currently serialized. It keeps the runner aligned with the gauntlet's
      // authoritative port accounting and available to debugger projections.
      void (state.chargedReads - readsBefore);
      if (rung.cleanup) await rung.cleanup(context);
    }
  }
  return result(plan, state, outcome, verdictsAtEntry);
}

/** Total already claimed by verdicts appended since `from`. */
function chargesSince(state: MutableRunState, from: number): number {
  let total = 0;
  for (let index = from; index < state.verdicts.length; index += 1) {
    const verdict = state.verdicts[index]!;
    if (verdict.kind !== 'skipped') total += verdict.chargedActions;
  }
  return total;
}

/**
 * How many verdicts of one call reach the model.
 *
 * The serialized ledger is bounded like every other model-visible list. When a
 * run produces more, the first record and the last `N - 1` are kept — the
 * opening move and the outcome are the two ends a caller needs — and the gap is
 * visible from the retained ordinals rather than silent.
 */
export const MAX_SERIALIZED_VERDICTS = 24;

/** Durable snake-case projection written to `details.attempted`. */
export function toWireLedger(ledger: EscalationLedger): readonly SerializedVerdict[] {
  return verdictsToWire(bounded(ledger.verdicts));
}

/** Keep the opening move and the outcome when a run outgrows the bound. */
function bounded<T>(verdicts: readonly T[]): readonly T[] {
  if (verdicts.length <= MAX_SERIALIZED_VERDICTS) return verdicts;
  return [verdicts[0]!, ...verdicts.slice(verdicts.length - (MAX_SERIALIZED_VERDICTS - 1))];
}

/**
 * Convert either legacy attempts or verdicts at a serialization boundary.
 *
 * Idempotent over its own output, allowlisted evidence keys included, which is
 * what makes it safe to leave in place wherever a legacy producer still exists.
 */
export function toWireAttemptArtifact(value: unknown): readonly SerializedVerdict[] {
  return verdictsToWire(normalizeAttemptArtifact(value));
}

function verdictsToWire(verdicts: readonly RungVerdictProjection[]): readonly SerializedVerdict[] {
  return verdicts.map((verdict) => {
    const base = {
      ordinal: verdict.ordinal,
      strategy: verdict.rungId,
      axis: verdict.axis,
      verdict: verdict.kind,
    };
    if (verdict.kind === 'skipped') return { ...base, unmet: verdict.unmet };
    // Omitted, never emitted empty. A key whose value is `[]`, `0` or `null` on
    // every record was 1.5 KB of model-visible noise per failing call and made
    // "which axis spent the budget?" unanswerable rather than answerable.
    //
    // Zero is omitted alongside unknown deliberately: "this rung charged
    // nothing", "it took no measurable time" and "it did not say" read
    // identically to a caller, so emitting the key buys nothing and costs the
    // reader a field to skip on every record.
    const measured = {
      ...base,
      ...(present(verdict.entryEvidence) ? { entry_evidence: verdict.entryEvidence } : {}),
      ...(present(verdict.chargedActions) ? { charged_actions: verdict.chargedActions } : {}),
      ...(present(verdict.remainingActions) ? { remaining_actions: verdict.remainingActions } : {}),
      ...(present(verdict.elapsedMs) ? { elapsed_ms: verdict.elapsedMs } : {}),
    };
    // Allowlisted, scalar-only. Everything else a rung produced is internal
    // plan evidence and stays there.
    const disclosed = serializedEvidence(verdict.evidence);
    if (verdict.kind === 'succeeded') return { ...measured, ...disclosed };
    return {
      ...measured,
      ...disclosed,
      error_code: verdict.errorCode,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    };
  });
}

/** True when a measured field says something a reader can act on. */
function present(value: number | readonly string[] | undefined): boolean {
  if (value === undefined) return false;
  return typeof value === 'number' ? value !== 0 : value.length > 0;
}

/** Normalize both legacy and verdict-shaped artifacts without rewriting them. */
export function normalizeAttemptArtifact(value: unknown): readonly RungVerdictProjection[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => normalizeRecord(entry, index + 1));
}

/** Validate static plan invariants before page work starts. */
export function assertPlanShape<TValue, TFailure, TPort>(
  plan: EscalationPlan<TValue, TFailure, TPort>,
): void {
  if (plan.rungs.length === 0) throw new Error(`Escalation plan "${plan.operation}" has no rungs.`);
  const ids = new Set<string>();
  const produced = new Set<string>();
  for (const rung of plan.rungs) {
    if (ids.has(rung.id)) throw new Error(`Duplicate escalation rung id "${rung.id}".`);
    ids.add(rung.id);
    if (!isAxis(rung.axis)) throw new Error(`Escalation rung "${rung.id}" has an invalid axis.`);
    if (!Number.isFinite(rung.costCap.maxActions) || rung.costCap.maxActions < 0) {
      throw new Error(`Escalation rung "${rung.id}" has an invalid action cap.`);
    }
    if (
      rung.costCap.maxElapsedMs !== undefined &&
      (!Number.isFinite(rung.costCap.maxElapsedMs) || rung.costCap.maxElapsedMs < 0)
    ) {
      throw new Error(`Escalation rung "${rung.id}" has an invalid elapsed-time cap.`);
    }
    const accessed = new Set<string>();
    const values = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (_target, property) => {
          if (typeof property === 'string') accessed.add(property);
          return undefined;
        },
      },
    );
    rung.entry(
      { values, verdicts: [], lastOutcome: null, lastFailure: null },
      {
        deadlineMs: plan.budget.deadlineMs,
        remainingActions: plan.budget.maxActions,
        remainingMs: Number.MAX_SAFE_INTEGER,
        chargedActions: 0,
        chargedReads: 0,
        reacquisitions: 0,
      },
    );
    const undeclared = [...accessed].filter((key) => !produced.has(key));
    if (undeclared.length > 0) {
      throw new Error(
        `Escalation rung "${rung.id}" reads evidence not produced earlier: ${undeclared.join(', ')}.`,
      );
    }
    for (const key of rung.produces) produced.add(key);
  }
}

/**
 * Identity of the run a port already charges into.
 *
 * Non-enumerable and keyed by symbol so a wrapped port stays structurally a
 * `WidgetPort` — every consumer, every spy and every `satisfies` table sees the
 * same shape.
 */
const RUN_STATE_TAG = Symbol.for('yantra.interaction.runState');

/**
 * The one port wrapper that counts a run's work and heals its stale refs.
 *
 * **Idempotent for the same run.** A rung body that hands its own
 * `context.port` to a nested plan gets that same wrapper back, so each mutation
 * and each read is charged exactly once however deep the nesting goes. Wrapping
 * for a *different* run charges both, because those are two calls.
 *
 * Healing is read from `state.reacquire` at call time rather than captured
 * here, so a port wrapped before the run's owner installed its policy still
 * heals through it — and a single shared cap bounds every wrapper.
 */
export function runStatePort(port: WidgetPort, state: MutableRunState): WidgetPort {
  if (runStateOf(port) === state) return port;
  const mutation = <T>(run: () => Promise<T>): Promise<T> => {
    state.chargedActions += 1;
    return run();
  };
  const read = <T>(run: () => Promise<T>): Promise<T> => {
    state.chargedReads += 1;
    return run();
  };
  const owned = new Map<string, string>();
  const onRef = async <T>(ref: string, run: (liveRef: string) => Promise<T>): Promise<T> => {
    const current = owned.get(ref) ?? ref;
    try {
      return await run(current);
    } catch (error) {
      if (!isStaleRefError(error) || !state.reacquire) throw error;
      if (state.reacquisitions >= state.maxReacquisitions) throw error;
      const next = await state.reacquire(current);
      if (next === null) throw error;
      state.reacquisitions += 1;
      owned.set(ref, next);
      return run(next);
    }
  };
  const wrapped: WidgetPort = {
    observe: (value) => read(() => port.observe(value)),
    click: (ref) => mutation(() => onRef(ref, (liveRef) => port.click(liveRef))),
    fill: (ref, value) => mutation(() => onRef(ref, (liveRef) => port.fill(liveRef, value))),
    clear: (ref) => mutation(() => onRef(ref, (liveRef) => port.clear(liveRef))),
    type: (ref, text, value) =>
      mutation(() => onRef(ref, (liveRef) => port.type(liveRef, text, value))),
    evaluateOn: (ref, fn, ...args) =>
      read(() => onRef(ref, (liveRef) => port.evaluateOn(liveRef, fn, ...args))),
    evaluate: (fn, ...args) => read(() => port.evaluate(fn, ...args)),
    press: (key) => mutation(() => port.press(key)),
    scrollContainer: (container, step) => mutation(() => port.scrollContainer(container, step)),
    now: () => port.now(),
  };
  Object.defineProperty(wrapped, RUN_STATE_TAG, {
    value: state,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return wrapped;
}

/** The run a port already charges into, when it is one of ours. */
function runStateOf(port: unknown): MutableRunState | undefined {
  if (typeof port !== 'object' || port === null) return undefined;
  return (port as Record<symbol, MutableRunState | undefined>)[RUN_STATE_TAG];
}

function result<TValue, TFailure, TPort>(
  plan: EscalationPlan<TValue, TFailure, TPort>,
  state: MutableRunState,
  outcome: RungOutcome<TValue, TFailure> | null,
  verdictsAtEntry: number,
): EscalationRun<TValue, TFailure> {
  return {
    outcome,
    ledger: {
      ...escalationLedgerOf(state, plan),
      // Scoped to this plan. The caller that owns the run projects the whole
      // sequence through `escalationLedgerOf`; a sub-plan reports what it did.
      verdicts: state.verdicts.slice(verdictsAtEntry),
    },
  };
}

function budgetOf(state: MutableRunState, now: number): BudgetState {
  return {
    deadlineMs: state.deadlineMs,
    remainingActions: Math.max(0, state.maxActions - state.chargedActions),
    remainingMs: Math.max(0, state.deadlineMs - now),
    chargedActions: state.chargedActions,
    chargedReads: state.chargedReads,
    reacquisitions: state.reacquisitions,
  };
}

function evidenceOf(state: MutableRunState): RungEvidence {
  return {
    values: { ...state.values },
    verdicts: [...state.verdicts],
    lastOutcome: state.lastOutcome,
    lastFailure: state.lastFailure,
  };
}

function budgetDecision(cost: RungCost, budget: BudgetState, enforceCaps: boolean): string | null {
  if (budget.remainingMs <= 0) return 'deadline-expired';
  if (!enforceCaps) return null;
  if (cost.maxElapsedMs !== undefined && cost.maxElapsedMs > budget.remainingMs) {
    return 'insufficient-remaining-budget';
  }
  if (cost.maxActions > budget.remainingActions) return 'insufficient-remaining-budget';
  return null;
}

function wrapPort<TValue, TFailure, TPort>(
  port: TPort,
  plan: EscalationPlan<TValue, TFailure, TPort>,
  state: MutableRunState,
): TPort {
  if (!isWidgetPort(port)) return port;
  // A plan that declares how to find its node again installs that policy on the
  // run once. The run — not the wrapper, and not the plan — owns the cap.
  if (plan.reacquire && state.reacquire === null) state.reacquire = plan.reacquire;
  return runStatePort(port, state) as TPort;
}

function isWidgetPort(value: unknown): value is WidgetPort {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return [
    'observe',
    'click',
    'fill',
    'clear',
    'type',
    'evaluateOn',
    'evaluate',
    'press',
    'scrollContainer',
    'now',
  ].every((key) => typeof record[key] === 'function');
}

function isStaleRefError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'STALE_ELEMENT_REF'
  );
}

function describeFailure(value: unknown): {
  readonly errorCode: string;
  readonly cause?: InteractionFailureCause;
  readonly detail?: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (typeof value !== 'object' || value === null) {
    return { errorCode: 'UNKNOWN_FAILURE', detail: String(value), details: {} };
  }
  const record = value as Record<string, unknown>;
  const details = isRecord(record.details) ? record.details : {};
  return {
    errorCode: typeof record.errorCode === 'string' ? record.errorCode : 'UNKNOWN_FAILURE',
    ...(typeof record.cause === 'string' ? { cause: record.cause as InteractionFailureCause } : {}),
    ...(typeof record.observed === 'string'
      ? {
          detail:
            record.observed.length > 0 ? `observed "${record.observed}"` : 'field stayed empty',
        }
      : typeof record.message === 'string'
        ? { detail: record.message }
        : {}),
    details,
  };
}

function normalizeRecord(value: unknown, ordinal: number): RungVerdictProjection {
  const record = isRecord(value) ? value : {};
  const axis = isAxis(record.axis) ? record.axis : 'how';
  const rungId = stringValue(record.strategy) ?? stringValue(record.rungId) ?? `attempt-${ordinal}`;
  const actualOrdinal = numberValue(record.ordinal) ?? numberValue(record.attempt) ?? ordinal;
  const kind = record.verdict ?? record.kind;
  if (kind === 'skipped') {
    return {
      kind: 'skipped',
      ordinal: actualOrdinal,
      rungId,
      axis,
      unmet: stringValue(record.unmet) ?? 'malformed-artifact',
    };
  }
  const errorCode = stringValue(record.error_code) ?? stringValue(record.errorCode);
  const entryEvidence = record.entry_evidence ?? record.entryEvidence;
  const chargedActions = numberValue(record.charged_actions ?? record.chargedActions);
  const remainingActions = numberValue(record.remaining_actions ?? record.remainingActions);
  const elapsedMs = numberValue(record.elapsed_ms ?? record.elapsedMs);
  // Absent, not zero. A legacy record never measured these, and reading it as
  // "spent nothing, has nothing left" is a claim the artifact never made.
  const measured = {
    ordinal: actualOrdinal,
    rungId,
    axis,
    ...(Array.isArray(entryEvidence) ? { entryEvidence: stringArray(entryEvidence) } : {}),
    ...(chargedActions === undefined ? {} : { chargedActions }),
    ...(remainingActions === undefined ? {} : { remainingActions }),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    // Allowlisted evidence survives the round trip, which is what makes this
    // projection idempotent over its own output.
    evidence: serializedEvidence(record),
  };
  if ((kind === 'succeeded' || kind === undefined) && errorCode === undefined) {
    return { kind: 'succeeded', ...measured };
  }
  return {
    kind: 'failed',
    ...measured,
    errorCode: errorCode ?? 'MALFORMED_ATTEMPT_RECORD',
    ...(stringValue(record.detail) === undefined ? {} : { detail: stringValue(record.detail)! }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAxis(value: unknown): value is InteractionAxis {
  return value === 'where' || value === 'what' || value === 'how';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
