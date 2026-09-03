import {
  assertHostBinding,
  defaultWidgetBudget,
  dismissWidget,
  fillField,
  fillSecretField,
  parseFillValue,
  runEscalationPlan,
  toLegacyLedger,
  toWireAttemptArtifact,
  withSecret,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type FillIntent,
  type FillOutcome,
  type FillResolution,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain, type TraceFillValue } from '../../../runtime/trace.js';

import {
  actionMetadataSink,
  browserController,
  browserFailure,
  browserWidgetPort,
  deltaAfterAction,
  deltaDetails,
  drainFillMetadata,
  followSiteOpenedTab,
  isDomainFailure,
  mapFillFailure,
  modelActionMetadata,
  modelDelta,
  modelObservation,
  recordActionProvenance,
  resolveFillField,
  resolveFillTarget,
  safeLocatorFor,
  type ActionMetadataSink,
  type ResolvedFillField,
} from './browser-common.js';
import { buildFieldFillPlan, type FieldFillOperations } from './interaction-plans.js';

export const FillValueSchema = Type.Union(
  [
    Type.String({
      maxLength: 4096,
      description: 'Non-secret text, offered option, checked state, ISO date, or ISO date range.',
    }),
    Type.Object(
      {
        kind: Type.Literal('literal'),
        value: Type.String({ maxLength: 4096, description: 'Non-secret value to commit.' }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        kind: Type.Literal('secret_ref'),
        key: Type.String({
          pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$',
          description: 'Website secret key; host bindings come from trusted metadata.',
        }),
      },
      { additionalProperties: false },
    ),
  ],
  {
    description:
      'A plain non-secret value, an explicit literal, or a host-bound stored-secret reference.',
  },
);

const BrowserFillElementParams = Type.Object(
  {
    field: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Visible accessible field name or current eNN ref from browser_observe.',
    }),
    value: FillValueSchema,
  },
  { additionalProperties: false },
);

export type BrowserFillValue = Static<typeof FillValueSchema>;
type Params = Static<typeof BrowserFillElementParams>;

export interface AppliedBrowserFill {
  readonly field: string;
  readonly ref: string;
  readonly driver: string;
  readonly dismissed: boolean;
  readonly actions: number;
  readonly committed?: string;
  /** What was asked for, so a differing `committed` reads as a resolution. */
  readonly requested?: string;
  /** How `committed` relates to `requested`. */
  readonly resolution?: FillResolution;
  /** What the widget was offering when it chose. */
  readonly offered?: readonly string[];
  /** One sentence, present only when `committed` differs from `requested`. */
  readonly note?: string;
  /** The recovery the engine performed, when it needed more than one attempt. */
  readonly attempted?: readonly Record<string, unknown>[];
  /**
   * The control the engine actually edited, when the page routed the edit away.
   *
   * A trigger that opens an overlay and forwards keystrokes to the overlay's
   * own input leaves the named control empty while the value lands correctly.
   * Saying which node took it is what stops a caller re-filling a field that is
   * already set.
   */
  readonly editee?: { readonly ref: string; readonly name: string; readonly role: string };
  /** Every caller field this one fill accounts for, when it covers more than its own. */
  readonly covers?: readonly string[];
}

/** Build the unified single-control fill tool. */
export function browserFillElementSpec(
  services: RunServices,
): ToolWrapperSpec<typeof BrowserFillElementParams> {
  return {
    name: 'browser_fill_element',
    label: 'Browser Fill Element',
    description:
      'Fill ONE control through the deterministic semantic fill engine — a form with a single field to set, or a stored secret. When two or more fields of the same form need values, use browser_fill_form in one call instead: filling them one at a time re-resolves each field against a page the previous fill re-rendered. Handles text, suggestions, choices, toggles, dates, and ranges. Success reports requested, committed, and resolution: a committed value that differs from what you sent is the widget resolving your value, not a failure. It also reports editee when the page routed the edit to a different control — the value landed there, and the field you named staying empty is expected. Success also carries delta: what changed between the page you last saw and this one — URL, dialogs opened or closed, how many elements appeared or vanished, where focus went — which describes the action window rather than claiming this fill caused every change, lists only dialogs it saw open or close rather than asserting none are open, and says complete: false with a reason wherever a bound stopped it being definite. Failure reports observed, attempted verdicts (recovery already performed — never repeat it), and offered (re-issue with one of those strings verbatim). Do not use browser_click to operate a field widget or submit the form.',
    parameters: BrowserFillElementParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    requiresConfirmation: (params: Params) => isSecretRef(params.value),
    buildConfirmation: () => ({
      action_kind: 'fill',
      host: services.domain.browser?.controller.host() ?? '',
      description: 'Fill a protected website field using a host-bound secret.',
      consequence: 'reversible',
    }),
    run: (params: Params, ctx): Promise<DomainResult> => runFillElement(params, ctx.services),
  };
}

async function runFillElement(params: Params, services: RunServices): Promise<DomainResult> {
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  // One collector per top-level call. Everything the page raised while this
  // fill drove it is attributed to this fill, rather than surfacing on whatever
  // tool runs next.
  const sink = actionMetadataSink();
  const applied = await applyBrowserFill(params.field, params.value, services, undefined, sink);
  // Drained even on failure: a popup a failed fill opened must not leak forward
  // either, and the URLs the page produced are still evidence the run reached
  // organically.
  const metadata = drainFillMetadata(controller, sink);
  recordActionProvenance(services, metadata);
  if (isDomainFailure(applied)) return applied;
  // Followed *before* the post-action read, so when a tab is adopted the
  // observation and the delta describe the page the fill actually produced.
  const followed = await followSiteOpenedTab(services, controller, metadata);
  const observation = await controller.observe();
  // Taken from the observation the tool already owns: the delta costs no page
  // read of its own, and one fill call yields exactly one delta.
  const delta = deltaAfterAction(controller);
  return {
    ok: true,
    model: {
      ...(applied.committed === undefined ? {} : { committed: applied.committed }),
      ...(applied.requested === undefined ? {} : { requested: applied.requested }),
      ...(applied.resolution === undefined ? {} : { resolution: applied.resolution }),
      ...(applied.offered === undefined ? {} : { offered: applied.offered }),
      ...(applied.note === undefined ? {} : { note: applied.note }),
      ...(applied.attempted === undefined ? {} : { attempted: applied.attempted }),
      ...(applied.editee === undefined ? {} : { editee: applied.editee }),
      driver: applied.driver,
      dismissed: applied.dismissed,
      ...modelActionMetadata(followed),
      observation: modelObservation(observation),
      ...(delta ? { delta: modelDelta(delta) } : {}),
    },
    details: {
      actions: applied.actions,
      ...(isSecretRef(params.value) ? { secret_key: params.value.key } : {}),
      ...deltaDetails(observation, delta ?? undefined),
    },
  };
}

/**
 * A failed field, carrying the control it resolved to.
 *
 * The target travels with the failure because the batch has to know which
 * widget group the failure belongs to, and it must know that *after* the fill
 * has already dismissed whatever it opened. Re-deriving it then would find a
 * closed widget and answer null.
 */
export interface FailedBrowserFill extends DomainFailure {
  readonly target?: WidgetTarget;
}

/** Apply one field without taking the caller-owned post-action observation. */
export async function applyBrowserFill(
  field: string,
  value: BrowserFillValue,
  services: RunServices,
  preresolved?: ResolvedFillField,
  sink?: ActionMetadataSink,
): Promise<AppliedBrowserFill | FailedBrowserFill> {
  const deps = services.domain.browser;
  const controller = browserController(services);
  if (!deps || isDomainFailure(controller)) {
    return isDomainFailure(controller)
      ? controller
      : {
          ok: false,
          errorCode: 'BROWSER_UNAVAILABLE',
          message: renderAgentMessage('tool', 'BROWSER_UNAVAILABLE', 'services-missing'),
          retryable: false,
        };
  }
  const located = preresolved ?? (await resolveFillField(field, controller));
  if (isDomainFailure(located)) return located;
  const target = located.target;
  // Threaded through both the literal path below and the secret path further
  // down, so a credential fill that opens a popup is attributed like any other.
  const port = browserWidgetPort(controller, services.now, sink);

  if (!isSecretRef(value)) {
    const literal = literalText(value);
    const intent = parseFillValue(literal, target.role);
    if (!('kind' in intent)) return mapFillFailure(intent);
    let outcome: FillOutcome;
    try {
      outcome = await driveWithRetry(port, controller, field, target, intent, {
        observation: located.observation,
      });
    } catch (error) {
      return browserFailure(error, services);
    }
    if (!outcome.ok) {
      await bestEffortDismiss(port, target);
      return { ...mapFillFailure(outcome), target };
    }
    await appendSemanticTrace(
      controller,
      target,
      { kind: 'literal', value: services.userInput?.mask(literal) ?? literal },
      services,
    );
    return {
      field,
      ref: target.ref,
      driver: outcome.driver,
      committed: outcome.committed,
      dismissed: outcome.dismissed,
      actions: outcome.actions,
      ...(outcome.requested === undefined ? {} : { requested: outcome.requested }),
      ...(outcome.resolution === undefined ? {} : { resolution: outcome.resolution }),
      ...(outcome.offered === undefined ? {} : { offered: outcome.offered }),
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
      ...(outcome.attempted === undefined
        ? {}
        : { attempted: toWireAttemptArtifact(outcome.attempted) }),
      ...(outcome.editee === undefined ? {} : { editee: outcome.editee }),
    };
  }

  if (!deps.secretResolver) {
    return {
      ok: false,
      errorCode: 'SECRET_RESOLVER_UNAVAILABLE',
      message: renderAgentMessage('tool', 'SECRET_RESOLVER_UNAVAILABLE', 'resolver-missing'),
      retryable: false,
    };
  }
  const hosts = await deps.secretHosts(value.key);
  try {
    assertHostBinding({ kind: 'secret', key: value.key, hosts: [...hosts] }, controller.host());
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'SECRET_HOST_MISMATCH') {
      return {
        ok: false,
        errorCode: 'SECRET_HOST_MISMATCH',
        message: renderAgentMessage('tool', 'SECRET_HOST_MISMATCH', 'host-binding', {
          message: error.message,
        }),
        retryable: false,
      };
    }
    throw error;
  }
  const resolved = await deps.secretResolver.resolve(
    { kind: 'secret', key: value.key },
    {
      taskParams: {},
      captures: {},
      stepId: 'browser_fill_element',
      taskId: services.runId,
      secretFieldExpected: true,
    },
  );
  try {
    const outcome = await withSecret(resolved.value, (secret) =>
      fillSecretField(port, { field, target }, secret, defaultWidgetBudget(port)),
    );
    if (!outcome.ok) return mapFillFailure(outcome);
    await appendSemanticTrace(controller, target, { kind: 'secret_ref', key: value.key }, services);
    return {
      field,
      ref: target.ref,
      driver: outcome.driver,
      dismissed: outcome.dismissed,
      actions: outcome.actions,
    };
  } catch (error) {
    return browserFailure(error, services);
  } finally {
    resolved.dispose();
  }
}

export function isSecretRef(
  value: BrowserFillValue,
): value is Extract<BrowserFillValue, { kind: 'secret_ref' }> {
  return typeof value === 'object' && value.kind === 'secret_ref';
}

function literalText(value: Exclude<BrowserFillValue, { kind: 'secret_ref' }>): string {
  return typeof value === 'string' ? value : value.value;
}

async function appendSemanticTrace(
  controller: AgentBrowserController,
  target: WidgetTarget,
  value: TraceFillValue,
  services: RunServices,
): Promise<void> {
  const described = controller.describeRef(target.ref) ?? target;
  const ranked = await safeLocatorFor(controller, target.ref);
  services.trace?.append({
    kind: 'fill_element',
    host: controller.host(),
    field: {
      role: described.role,
      name: described.name,
      group: described.group ?? null,
    },
    locator: ranked.length > 0 ? ranked : toCandidateChain(described.role, described.name),
    value,
    requires_confirmation: value.kind === 'secret_ref',
  });
}

async function bestEffortDismiss(port: WidgetPort, target: WidgetTarget): Promise<void> {
  await dismissWidget(port, target, '', () => true).catch(() => undefined);
}

/**
 * Drive one field, and when the page replaced the control out from under the
 * engine, resolve the field again from scratch and drive it once more.
 *
 * The engine already re-acquires a replaced node mid-drive, but a site that
 * re-mounts its whole search form can outrun that from the very first click and
 * leave the caller holding a target that no longer exists. Re-resolving by the
 * caller's own field name against a fresh observation is the recovery a model
 * would otherwise have to perform by hand — and in the run that motivated this,
 * doing it by hand is what pulled the agent into operating the calendar with
 * raw clicks. Only `WIDGET_ELEMENT_REPLACED` is retried: every other failure
 * describes a page that answered, where a second identical attempt would answer
 * the same way.
 */
type DriveWithRetryDependencies = FieldFillOperations;

const DEFAULT_FILL_RETRY_DEPENDENCIES: DriveWithRetryDependencies = {
  drive: fillField,
  resolve: resolveFillTarget,
};

/** What the caller already knows about the page it resolved the field from. */
export interface DriveContext {
  /**
   * The observation the target came from.
   *
   * Handed on so the engine's editee resolution has its before-picture for
   * free. Only the first attempt can use it — a retry re-resolves against a
   * page that has since changed, and comparing against a stale baseline would
   * name a control whose value moved for unrelated reasons.
   */
  readonly observation?: AgentBrowserObservation;
}

export async function driveWithRetry(
  port: WidgetPort,
  controller: AgentBrowserController,
  field: string,
  target: WidgetTarget,
  intent: FillIntent,
  context: DriveContext = {},
  dependencies: DriveWithRetryDependencies = DEFAULT_FILL_RETRY_DEPENDENCIES,
): Promise<FillOutcome> {
  const budget = defaultWidgetBudget(port);
  const built = buildFieldFillPlan({
    ...dependencies,
    port,
    controller,
    field,
    target,
    intent,
    budget,
    ...(context.observation ? { observation: context.observation } : {}),
  });
  const run = await runEscalationPlan(built.plan);
  const attempted = toLegacyLedger(run.ledger).records.map((record) =>
    record.strategy === 're-resolve-field-and-retry' && built.resolutionFailure()
      ? {
          ...record,
          detail: `field re-resolution failed with ${built.resolutionFailure()!.errorCode}`,
        }
      : record,
  );
  if (run.outcome?.ok) {
    return run.ledger.verdicts.filter((verdict) => verdict.kind !== 'skipped').length > 1
      ? { ...run.outcome.value, attempted }
      : run.outcome.value;
  }
  if (!run.outcome) {
    throw new Error('Field fill plan produced no outcome.');
  }
  const failure = run.outcome.failure;
  const expired = run.ledger.verdicts.some(
    (verdict) => verdict.kind === 'skipped' && verdict.unmet === 'deadline-expired',
  );
  return {
    ...failure,
    ...(expired
      ? {
          message: 'The field was re-resolved, but the original fill deadline expired.',
          retryable: false,
        }
      : {}),
    details: { ...failure.details, ...(expired ? { reason: 'budget' } : {}), attempted },
  };
}
