import {
  classifyFailure,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type BrowserActionResult,
  type EscalationPlan,
  type FillFailure,
  type FillIntent,
  type FillOutcome,
  type WidgetBudget,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';

import type { DomainFailure } from '../../../runtime/middleware.js';

export interface FieldFillOperations {
  readonly drive: (
    port: WidgetPort,
    identity: {
      readonly field: string;
      readonly target: WidgetTarget;
      readonly observation?: AgentBrowserObservation;
    },
    intent: FillIntent,
    budget?: WidgetBudget,
  ) => Promise<FillOutcome>;
  readonly resolve: (
    field: string,
    controller: AgentBrowserController,
    preferred?: WidgetTarget,
  ) => Promise<WidgetTarget | DomainFailure>;
}

export interface FieldFillPlanInput extends FieldFillOperations {
  readonly port: WidgetPort;
  readonly controller: AgentBrowserController;
  readonly field: string;
  readonly target: WidgetTarget;
  readonly intent: FillIntent;
  readonly observation?: AgentBrowserObservation;
  readonly budget: WidgetBudget;
}

export interface FieldFillPlanBuild {
  readonly plan: EscalationPlan<
    Extract<FillOutcome, { readonly ok: true }>,
    FillFailure,
    WidgetPort
  >;
  readonly resolutionFailure: () => DomainFailure | null;
}

/** Declare the agent-side field recovery policy without owning its execution loop. */
export function buildFieldFillPlan(input: FieldFillPlanInput): FieldFillPlanBuild {
  let activeTarget = input.target;
  let replacementFailure: FillFailure | null = null;
  let failedResolution: DomainFailure | null = null;

  return {
    resolutionFailure: () => failedResolution,
    plan: {
      family: 'field',
      operation: 'fill-field',
      port: input.port,
      budget: { ...input.budget, maxReacquisitions: 4 },
      now: () => input.port.now(),
      classify: (failure) =>
        failure.errorCode === 'WIDGET_ELEMENT_REPLACED'
          ? classifyFailure(failure.errorCode, failure.details)
          : 'terminal',
      rungs: [
        {
          id: 'fill',
          axis: 'how',
          entry: () => ({ enter: true, evidence: ['resolved-field'] }),
          costCap: { maxActions: Math.min(16, input.budget.maxActions) },
          produces: ['fill-outcome'],
          run: async ({ port }) => {
            const outcome = await input.drive(
              port,
              {
                field: input.field,
                target: activeTarget,
                ...(input.observation ? { observation: input.observation } : {}),
              },
              input.intent,
              input.budget,
            );
            if (outcome.ok) return { ok: true, value: outcome };
            replacementFailure = outcome;
            return { ok: false, failure: outcome };
          },
        },
        {
          id: 're-resolve-field-and-retry',
          axis: 'where',
          entry: (evidence) =>
            failureCode(evidence.lastFailure) === 'WIDGET_ELEMENT_REPLACED'
              ? { enter: true, evidence: ['previous:WIDGET_ELEMENT_REPLACED'] }
              : { enter: false, unmet: 'field-was-not-replaced' },
          // Admission reserves one mutation, not sixteen. This rung exists to
          // run *after* an expensive first fill, and both fills now spend one
          // shared allowance — so declaring half the ceiling here would make the
          // retry structurally unreachable in exactly the case it was built for.
          // The real bound is the shared ceiling and the shared deadline, which
          // the retried fill is admitted against rung by rung.
          costCap: { maxActions: Math.min(1, input.budget.maxActions) },
          produces: ['re-resolved-field', 'fill-outcome'],
          run: async ({ port }) => {
            const fresh = await input.resolve(input.field, input.controller, input.target);
            if (isDomainFailure(fresh)) {
              failedResolution = fresh;
              return { ok: false, failure: replacementFailure! };
            }
            activeTarget = fresh;
            if (input.port.now() >= input.budget.deadlineMs) {
              return {
                ok: false,
                failure: {
                  ...replacementFailure!,
                  message: 'The field was re-resolved, but the original fill deadline expired.',
                  retryable: false,
                  details: { ...replacementFailure!.details, reason: 'budget' },
                },
              };
            }
            const outcome = await input.drive(
              port,
              { field: input.field, target: activeTarget },
              input.intent,
              input.budget,
            );
            return outcome.ok
              ? { ok: true, value: outcome, evidence: { reResolved: true } }
              : { ok: false, failure: outcome };
          },
        },
      ],
    },
  };
}

function failureCode(value: unknown): string | null {
  return typeof value === 'object' && value !== null && 'errorCode' in value
    ? String((value as { readonly errorCode: unknown }).errorCode)
    : null;
}

function isDomainFailure(value: WidgetTarget | DomainFailure): value is DomainFailure {
  return 'ok' in value && value.ok === false;
}

export interface ClickPlanInput {
  readonly initialRef: string;
  readonly deadlineMs: number;
  readonly now: () => number;
  readonly click: (ref: string) => Promise<BrowserActionResult | DomainFailure>;
  readonly reacquire: () => Promise<string | null>;
  readonly onReacquired?: (ref: string) => Promise<void> | void;
}

export interface ClickPlanBuild {
  readonly plan: EscalationPlan<BrowserActionResult, DomainFailure, undefined>;
  readonly resolvedBy: () => 'ref' | 're-resolved';
}

/** Declare one click followed by at most two identity-preserving recoveries. */
export function buildClickPlan(input: ClickPlanInput): ClickPlanBuild {
  let activeRef = input.initialRef;
  let resolvedBy: 'ref' | 're-resolved' = 'ref';
  let recoveryExhausted = false;
  const staleFailure = (): DomainFailure => ({
    ok: false,
    errorCode: 'STALE_ELEMENT_REF',
    message:
      `Element ref "${input.initialRef}" is gone and no element with the same name and ` +
      'role replaced it. Call browser_observe again for current refs.',
    retryable: true,
  });
  const click = async () => {
    const result = await input.click(activeRef);
    return isClickFailure(result)
      ? { ok: false as const, failure: result }
      : { ok: true as const, value: result };
  };
  const retry = async () => {
    const reacquired = await input.reacquire();
    if (reacquired === null) {
      recoveryExhausted = true;
      return { ok: false as const, failure: staleFailure() };
    }
    activeRef = reacquired;
    resolvedBy = 're-resolved';
    await input.onReacquired?.(activeRef);
    return click();
  };
  const mayRecover = (lastFailure: unknown) =>
    !recoveryExhausted && failureCode(lastFailure) === 'STALE_ELEMENT_REF'
      ? { enter: true as const, evidence: ['previous:STALE_ELEMENT_REF'] }
      : { enter: false as const, unmet: recoveryExhausted ? 'identity-not-found' : 'not-stale' };

  return {
    resolvedBy: () => resolvedBy,
    plan: {
      family: 'click',
      operation: 'click',
      port: undefined,
      budget: {
        deadlineMs: input.deadlineMs,
        maxActions: 3,
        maxPagingSteps: 0,
        maxReacquisitions: 2,
      },
      now: input.now,
      classify: (failure) =>
        recoveryExhausted
          ? 'terminal'
          : classifyFailure(
              failure.errorCode,
              typeof failure.details === 'object' && failure.details !== null
                ? (failure.details as Readonly<Record<string, unknown>>)
                : {},
            ),
      rungs: [
        {
          id: 'click',
          axis: 'how',
          entry: () => ({ enter: true, evidence: ['current-ref'] }),
          costCap: { maxActions: 1 },
          produces: ['click-outcome'],
          run: async ({ charge }) => {
            charge();
            return click();
          },
        },
        {
          id: 're-resolve-ref',
          axis: 'where',
          entry: (evidence) => mayRecover(evidence.lastFailure),
          costCap: { maxActions: 1 },
          produces: ['reacquired-ref', 'click-outcome'],
          run: async ({ charge }) => {
            charge();
            return retry();
          },
        },
        {
          id: 're-resolve-ref-2',
          axis: 'where',
          entry: (evidence) => mayRecover(evidence.lastFailure),
          costCap: { maxActions: 1 },
          produces: ['reacquired-ref', 'click-outcome'],
          run: async ({ charge }) => {
            charge();
            return retry();
          },
        },
      ],
    },
  };
}

function isClickFailure(value: BrowserActionResult | DomainFailure): value is DomainFailure {
  return 'ok' in value && value.ok === false;
}
