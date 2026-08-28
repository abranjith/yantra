import {
  assertHostBinding,
  defaultWidgetBudget,
  dismissWidget,
  fillField,
  fillSecretField,
  parseFillValue,
  withSecret,
  type AgentBrowserController,
  type AttemptRecord,
  type FillIntent,
  type FillOutcome,
  type FillResolution,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain, type TraceFillValue } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  browserWidgetPort,
  isDomainFailure,
  mapFillFailure,
  modelObservation,
  resolveFillTarget,
  safeLocatorFor,
} from './browser-common.js';

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
  readonly attempted?: readonly AttemptRecord[];
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
      'Fill ONE control through the deterministic semantic fill engine — a form with a single field to set, or a stored secret. When two or more fields of the same form need values, use browser_fill_form in one call instead: filling them one at a time re-resolves each field against a page the previous fill re-rendered. Handles text, suggestions, choices, toggles, dates, and ranges. Success reports requested, committed, and resolution: a committed value that differs from what you sent is the widget resolving your value, not a failure. Failure reports observed, attempted (recovery already performed — never repeat it), and offered (re-issue with one of those strings verbatim). Do not use browser_click to operate a field widget or submit the form.',
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
  const applied = await applyBrowserFill(params.field, params.value, services);
  if (isDomainFailure(applied)) return applied;
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  const observation = await controller.observe();
  return {
    ok: true,
    model: {
      ...(applied.committed === undefined ? {} : { committed: applied.committed }),
      ...(applied.requested === undefined ? {} : { requested: applied.requested }),
      ...(applied.resolution === undefined ? {} : { resolution: applied.resolution }),
      ...(applied.offered === undefined ? {} : { offered: applied.offered }),
      ...(applied.note === undefined ? {} : { note: applied.note }),
      ...(applied.attempted === undefined ? {} : { attempted: applied.attempted }),
      driver: applied.driver,
      dismissed: applied.dismissed,
      observation: modelObservation(observation),
    },
    details: {
      actions: applied.actions,
      ...(isSecretRef(params.value) ? { secret_key: params.value.key } : {}),
    },
  };
}

/** Apply one field without taking the caller-owned post-action observation. */
export async function applyBrowserFill(
  field: string,
  value: BrowserFillValue,
  services: RunServices,
): Promise<AppliedBrowserFill | DomainFailure> {
  const deps = services.domain.browser;
  const controller = browserController(services);
  if (!deps || isDomainFailure(controller)) {
    return isDomainFailure(controller)
      ? controller
      : {
          ok: false,
          errorCode: 'BROWSER_UNAVAILABLE',
          message: 'Browser services are not configured.',
          retryable: false,
        };
  }
  const target = await resolveFillTarget(field, controller);
  if (isDomainFailure(target)) return target;
  const port = browserWidgetPort(controller, services.now);

  if (!isSecretRef(value)) {
    const literal = literalText(value);
    const intent = parseFillValue(literal, target.role);
    if (!('kind' in intent)) return mapFillFailure(intent);
    let outcome: FillOutcome;
    try {
      outcome = await driveWithRetry(port, controller, field, target, intent);
    } catch (error) {
      return browserFailure(error);
    }
    if (!outcome.ok) {
      await bestEffortDismiss(port, target);
      return mapFillFailure(outcome);
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
      ...(outcome.attempted === undefined ? {} : { attempted: outcome.attempted }),
    };
  }

  if (!deps.secretResolver) {
    return {
      ok: false,
      errorCode: 'SECRET_RESOLVER_UNAVAILABLE',
      message: 'Website secret resolution is unavailable.',
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
        message: error.message,
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
    return browserFailure(error);
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
async function driveWithRetry(
  port: WidgetPort,
  controller: AgentBrowserController,
  field: string,
  target: WidgetTarget,
  intent: FillIntent,
): Promise<FillOutcome> {
  const first = await fillField(port, { field, target }, intent, defaultWidgetBudget(port));
  if (first.ok || first.errorCode !== 'WIDGET_ELEMENT_REPLACED') return first;
  const fresh = await resolveFillTarget(field, controller, target);
  if (isDomainFailure(fresh)) return first;
  return fillField(port, { field, target: fresh }, intent, defaultWidgetBudget(port));
}
