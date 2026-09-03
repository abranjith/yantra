/** Declarative recovery plans and their single execution/accounting owner. */

import type { WidgetPort } from '../widgets/types.js';

import type {
  AttemptDisposition,
  AttemptLedger,
  InteractionAxis,
  InteractionFailureCause,
} from './types.js';

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
      readonly errorCode: string;
      readonly cause?: InteractionFailureCause;
      readonly detail?: string;
    })
  | (VerdictBase & {
      readonly kind: 'skipped';
      readonly unmet: string;
    });

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

export interface MutableRunState {
  readonly startedAt: number;
  readonly deadlineMs: number;
  readonly maxActions: number;
  readonly verdicts: RungVerdict[];
  readonly values: Record<string, unknown>;
  chargedActions: number;
  chargedReads: number;
  reacquisitions: number;
  lastOutcome: unknown;
  lastFailure: unknown;
  lastNow: number;
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
  const root = parentState === undefined;
  const initialNow = parentState?.lastNow ?? plan.now();
  const state: MutableRunState = parentState ?? {
    startedAt: initialNow,
    deadlineMs: plan.budget.deadlineMs,
    maxActions: Math.max(0, Math.floor(plan.budget.maxActions)),
    verdicts: [],
    values: {},
    chargedActions: 0,
    chargedReads: 0,
    reacquisitions: 0,
    lastOutcome: null,
    lastFailure: null,
    lastNow: initialNow,
  };
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
      const chargedActions = state.chargedActions - actionsBefore;
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
  return result(plan, state, outcome, root);
}

/** Phase-two compatibility projection retained until every producer migrates. */
export function toLegacyLedger(ledger: EscalationLedger): AttemptLedger {
  let attempt = 0;
  return {
    records: ledger.verdicts.flatMap((verdict) => {
      if (verdict.kind === 'skipped') return [];
      attempt += 1;
      return [
        {
          attempt,
          strategy: verdict.rungId,
          axis: verdict.axis,
          errorCode: verdict.kind === 'failed' ? verdict.errorCode : null,
          elapsedMs: verdict.elapsedMs,
          ...(verdict.kind === 'failed' && verdict.detail !== undefined
            ? { detail: verdict.detail }
            : {}),
        },
      ];
    }),
  };
}

/** Durable snake-case projection written to `details.attempted`. */
export function toWireLedger(ledger: EscalationLedger): readonly Record<string, unknown>[] {
  return verdictsToWire(ledger.verdicts);
}

/** Convert either legacy attempts or verdicts at a serialization boundary. */
export function toWireAttemptArtifact(value: unknown): readonly Record<string, unknown>[] {
  return verdictsToWire(normalizeAttemptArtifact(value));
}

function verdictsToWire(verdicts: readonly RungVerdict[]): readonly Record<string, unknown>[] {
  return verdicts.map((verdict) => {
    const base = {
      ordinal: verdict.ordinal,
      strategy: verdict.rungId,
      axis: verdict.axis,
      verdict: verdict.kind,
    };
    if (verdict.kind === 'skipped') return { ...base, unmet: verdict.unmet };
    const measured = {
      ...base,
      entry_evidence: verdict.entryEvidence,
      charged_actions: verdict.chargedActions,
      remaining_actions: verdict.remainingActions,
      elapsed_ms: verdict.elapsedMs,
    };
    if (verdict.kind === 'succeeded') return { ...measured, ...verdict.evidence };
    return {
      ...measured,
      error_code: verdict.errorCode,
      ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
    };
  });
}

/** Normalize both legacy and verdict-shaped artifacts without rewriting them. */
export function normalizeAttemptArtifact(value: unknown): readonly RungVerdict[] {
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

/** Options for the stateful port every rung of one field operation shares. */
export interface RunnerOwnedPortOptions {
  readonly ownedRef: string;
  readonly maxReacquisitions: number;
  readonly reacquire: (currentRef: string) => Promise<string | null>;
  readonly onReacquire?: (count: number, ref: string) => void;
  readonly onAction?: (count: number) => void;
}

/**
 * Create the runner-owned stale-ref view used across every rung in a fill.
 * Unrelated refs pass through and are never candidates for healing.
 */
export function createRunnerOwnedPort(
  port: WidgetPort,
  options: RunnerOwnedPortOptions,
): WidgetPort {
  let currentRef = options.ownedRef;
  let reacquisitions = 0;
  let actions = 0;
  const mutation = <T>(run: () => Promise<T>): Promise<T> => {
    actions += 1;
    options.onAction?.(actions);
    return run();
  };
  const owns = (ref: string): boolean => ref === options.ownedRef || ref === currentRef;
  const onRef = async <T>(ref: string, run: (liveRef: string) => Promise<T>): Promise<T> => {
    const effective = owns(ref) ? currentRef : ref;
    try {
      return await run(effective);
    } catch (error) {
      if (
        !isStaleRefError(error) ||
        !owns(ref) ||
        reacquisitions >= Math.max(0, options.maxReacquisitions)
      ) {
        throw error;
      }
      const next = await options.reacquire(currentRef);
      if (next === null) throw error;
      currentRef = next;
      reacquisitions += 1;
      options.onReacquire?.(reacquisitions, next);
      return run(currentRef);
    }
  };
  return {
    observe: (value) => port.observe(value),
    click: (ref) => mutation(() => onRef(ref, (liveRef) => port.click(liveRef))),
    fill: (ref, value) => mutation(() => onRef(ref, (liveRef) => port.fill(liveRef, value))),
    clear: (ref) => mutation(() => onRef(ref, (liveRef) => port.clear(liveRef))),
    type: (ref, text, value) =>
      mutation(() => onRef(ref, (liveRef) => port.type(liveRef, text, value))),
    evaluateOn: (ref, fn, ...args) =>
      onRef(ref, (liveRef) => port.evaluateOn(liveRef, fn, ...args)),
    evaluate: (fn, ...args) => port.evaluate(fn, ...args),
    press: (key) => mutation(() => port.press(key)),
    scrollContainer: (container, step) => mutation(() => port.scrollContainer(container, step)),
    now: () => port.now(),
  };
}

function result<TValue, TFailure, TPort>(
  plan: EscalationPlan<TValue, TFailure, TPort>,
  state: MutableRunState,
  outcome: RungOutcome<TValue, TFailure> | null,
  root: boolean,
): EscalationRun<TValue, TFailure> {
  const verdicts = root ? state.verdicts : state.verdicts;
  return {
    outcome,
    ledger: {
      operation: plan.operation,
      family: plan.family,
      verdicts: [...verdicts],
      chargedActions: state.chargedActions,
      elapsedMs: state.lastNow - state.startedAt,
      remainingActions: Math.max(0, state.maxActions - state.chargedActions),
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
      if (!isStaleRefError(error) || !plan.reacquire) throw error;
      if (state.reacquisitions >= plan.budget.maxReacquisitions) throw error;
      const next = await plan.reacquire(current);
      if (next === null) throw error;
      state.reacquisitions += 1;
      owned.set(ref, next);
      return run(next);
    }
  };
  const wrapped: WidgetPort = {
    observe: (options) => read(() => port.observe(options)),
    click: (ref) => mutation(() => onRef(ref, (liveRef) => port.click(liveRef))),
    fill: (ref, value) => mutation(() => onRef(ref, (liveRef) => port.fill(liveRef, value))),
    clear: (ref) => mutation(() => onRef(ref, (liveRef) => port.clear(liveRef))),
    type: (ref, text, options) =>
      mutation(() => onRef(ref, (liveRef) => port.type(liveRef, text, options))),
    evaluateOn: (ref, fn, ...args) =>
      read(() => onRef(ref, (liveRef) => port.evaluateOn(liveRef, fn, ...args))),
    evaluate: (fn, ...args) => read(() => port.evaluate(fn, ...args)),
    press: (key) => mutation(() => port.press(key)),
    scrollContainer: (container, step) => mutation(() => port.scrollContainer(container, step)),
    now: () => port.now(),
  };
  return wrapped as TPort;
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

function normalizeRecord(value: unknown, ordinal: number): RungVerdict {
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
  const measured = {
    ordinal: actualOrdinal,
    rungId,
    axis,
    entryEvidence: stringArray(record.entry_evidence ?? record.entryEvidence),
    chargedActions: numberValue(record.charged_actions ?? record.chargedActions) ?? 0,
    remainingActions: numberValue(record.remaining_actions ?? record.remainingActions) ?? 0,
    elapsedMs: numberValue(record.elapsed_ms ?? record.elapsedMs) ?? 0,
  };
  if ((kind === 'succeeded' || kind === undefined) && errorCode === undefined) {
    return { kind: 'succeeded', ...measured, evidence: {} };
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
