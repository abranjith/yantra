/** Pure escalation-plan builders for core interaction families. */

import type { EscalationPlan, Rung, RungContext, RungOutcome } from '../interaction/escalation.js';
import type { QueryForm } from '../interaction/query-plan.js';
import type { DetectedWidgetDriver } from '../widgets/registry.js';
import type {
  WidgetBudget,
  WidgetFailure,
  WidgetFamily,
  WidgetIntent,
  WidgetPort,
  WidgetSuccess,
  WidgetTarget,
} from '../widgets/types.js';

export interface BuildComboboxPlanInput {
  readonly port: WidgetPort;
  readonly budget: WidgetBudget;
  readonly forms: readonly QueryForm[];
  readonly runForm: (
    context: RungContext<WidgetPort>,
    form: QueryForm,
    index: number,
  ) => Promise<RungOutcome<WidgetSuccess, WidgetFailure>>;
}

/** Build one WHAT rung per precomputed query form. */
export function buildComboboxPlan(
  input: BuildComboboxPlanInput,
): EscalationPlan<WidgetSuccess, WidgetFailure, WidgetPort> {
  const rungs: readonly Rung<WidgetSuccess, WidgetFailure, WidgetPort>[] = input.forms.map(
    (form, index) => ({
      id: `query:${form.kind}`,
      axis: 'what',
      entry: (evidence) => {
        if (index === 0) return { enter: true, evidence: [`query:${form.kind}`] };
        return evidence.values['previous-form-no-suggestions'] === true
          ? { enter: true, evidence: [`query:${form.kind}`, 'previous-form-no-suggestions'] }
          : { enter: false, unmet: 'previous-form-offered-candidates' };
      },
      costCap: { maxActions: Math.min(4, input.budget.maxActions) },
      produces: ['previous-form-no-suggestions', 'offered', 'chosen', 'committed', 'container'],
      run: (context) => input.runForm(context, form, index),
    }),
  );
  return {
    family: 'combobox',
    operation: 'fill-combobox',
    rungs,
    budget: asPlanBudget(input.budget),
    port: input.port,
    now: () => input.port.now(),
    classify: (failure) => (failure.details.planTransient === true ? 'transient' : 'terminal'),
  };
}

export interface BuildDriverPlanInput {
  readonly family: Extract<WidgetFamily, 'date' | 'option' | 'combobox'>;
  readonly port: WidgetPort;
  readonly target: WidgetTarget;
  readonly intent: WidgetIntent;
  readonly budget: WidgetBudget;
  readonly candidates: readonly DetectedWidgetDriver[];
  readonly isWrongDriver: (failure: WidgetFailure) => boolean;
  readonly probeEligible: boolean;
  readonly runProbe?: (
    context: RungContext<WidgetPort>,
  ) => Promise<RungOutcome<WidgetSuccess, WidgetFailure>>;
  readonly onDriverOutcome?: (rungId: string, outcome: WidgetSuccess | WidgetFailure) => void;
}

/** Build confidence-ordered driver rungs followed by the engine-owned probe. */
export function buildDriverPlan(
  input: BuildDriverPlanInput,
): EscalationPlan<WidgetSuccess, WidgetFailure, WidgetPort> {
  const driverRungs: Rung<WidgetSuccess, WidgetFailure, WidgetPort>[] = input.candidates.map(
    (candidate, index) => ({
      id: `driver:${candidate.driver.kind}`,
      axis: 'how',
      entry: (evidence) => {
        if (index === 0) return { enter: true, evidence: ['detected-driver'] };
        return evidence.values['previous-driver-wrong'] === true
          ? { enter: true, evidence: ['previous-driver-wrong'] }
          : { enter: false, unmet: 'driver-answered-definitively' };
      },
      // Admission reserves one mutation; paging/scroll choreography remains
      // bounded by the family budget that the driver receives below.
      costCap: { maxActions: Math.min(1, input.budget.maxActions) },
      produces: ['previous-driver-wrong', 'committed', 'offered', 'chosen', 'container'],
      run: async ({ port }) => {
        const outcome = await candidate.driver.drive(
          port,
          input.target,
          input.intent,
          input.budget,
        );
        input.onDriverOutcome?.(`driver:${candidate.driver.kind}`, outcome);
        if (outcome.ok) {
          return {
            ok: true,
            value: outcome,
            evidence: {
              'previous-driver-wrong': false,
              committed: outcome.committed,
              offered: outcome.offered ?? [],
              ...(outcome.chosen === undefined ? {} : { chosen: outcome.chosen }),
              ...(outcome.container === undefined ? {} : { container: outcome.container }),
            },
          };
        }
        return {
          ok: false,
          failure: outcome,
          evidence: { 'previous-driver-wrong': input.isWrongDriver(outcome) },
        };
      },
    }),
  );
  const probe: Rung<WidgetSuccess, WidgetFailure, WidgetPort> = {
    id: 'open-probe',
    axis: 'how',
    entry: () => {
      if (input.candidates.length > 0) {
        return { enter: false, unmet: 'driver-answered-definitively' };
      }
      return input.probeEligible && input.runProbe
        ? { enter: true, evidence: ['no-detected-driver', 'semantics-agree'] }
        : { enter: false, unmet: 'semantics-disagree' };
    },
    costCap: { maxActions: Math.min(1, input.budget.maxActions) },
    produces: ['container', 'committed', 'offered', 'chosen'],
    run: (context) =>
      input.runProbe
        ? input.runProbe(context)
        : Promise.resolve({
            ok: false,
            failure: {
              ok: false,
              errorCode: 'WIDGET_NOT_RECOGNIZED',
              cause: 'driver-not-recognized',
              message: 'No open probe was configured for this interaction family.',
              retryable: false,
              details: {},
            },
          }),
  };
  return {
    family: input.family,
    operation: `fill-${input.family}`,
    rungs: [...driverRungs, probe],
    budget: asPlanBudget(input.budget),
    port: input.port,
    now: () => input.port.now(),
    classify: (failure) => (input.isWrongDriver(failure) ? 'transient' : 'terminal'),
  };
}

export interface BuildTextPlanInput<TValue, TFailure> {
  readonly port: WidgetPort;
  readonly budget: WidgetBudget;
  readonly runEnter: (context: RungContext<WidgetPort>) => Promise<RungOutcome<TValue, TFailure>>;
  readonly runSelection: (
    context: RungContext<WidgetPort>,
  ) => Promise<RungOutcome<TValue, TFailure>>;
  readonly classify: (failure: TFailure) => 'transient' | 'terminal';
}

/** Build the plain-text entry and optional offered-selection stages. */
export function buildTextPlan<TValue, TFailure>(
  input: BuildTextPlanInput<TValue, TFailure>,
): EscalationPlan<TValue, TFailure, WidgetPort> {
  return {
    family: 'text',
    operation: 'fill-text',
    rungs: [
      {
        id: 'enter-text',
        axis: 'how',
        entry: () => ({ enter: true, evidence: [] }),
        costCap: { maxActions: Math.min(input.budget.maxActions, 6) },
        produces: ['text-entered', 'committed', 'editee'],
        run: input.runEnter,
      },
      {
        id: 'watch-and-select',
        axis: 'what',
        entry: (evidence) =>
          evidence.values['text-entered'] === true
            ? { enter: true, evidence: ['text-entered'] }
            : { enter: false, unmet: 'control-not-empty' },
        costCap: { maxActions: Math.min(input.budget.maxActions, 2) },
        produces: ['offered', 'chosen', 'committed', 'container'],
        run: input.runSelection,
      },
    ],
    budget: asPlanBudget(input.budget),
    port: input.port,
    now: () => input.port.now(),
    classify: input.classify,
  };
}

/** Convert the established widget allowance into the runner-owned shape. */
export function asPlanBudget(budget: WidgetBudget): {
  readonly deadlineMs: number;
  readonly maxActions: number;
  readonly maxPagingSteps: number;
  readonly maxReacquisitions: number;
  readonly maxScrollSteps: number;
} {
  return {
    deadlineMs: budget.deadlineMs,
    maxActions: budget.maxActions,
    maxPagingSteps: budget.maxPagingSteps ?? 12,
    maxReacquisitions: 4,
    maxScrollSteps: budget.maxScrollSteps ?? 8,
  };
}
