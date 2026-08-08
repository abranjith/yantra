/**
 * `browser_form_fill` fills an ordered form in one call. Each field is resolved
 * from a fresh uncapped observation, then delegated to the same semantic widget
 * registry used by `browser_pick_date` and `browser_pick_option`. Unrecognized
 * text-like fields retain the ordinary settled fill path. The tool never
 * submits and never accepts credentials.
 */

import {
  createDefaultWidgetRegistry,
  defaultWidgetBudget,
  readCommitted,
  type AgentBrowserController,
  type WidgetIntent,
  type WidgetTarget,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  browserController,
  browserFailure,
  isDomainFailure,
  modelObservation,
} from './browser-common.js';
import {
  elementReplacedFailure,
  isStaleRefError,
  mapWidgetFailure,
  resolveWidgetTarget,
  SECRET_SHAPE,
  tracedWidgetPort,
} from './browser-widget-common.js';

const BrowserFormFillParams = Type.Object(
  {
    fields: Type.Array(
      Type.Object(
        {
          field: Type.String({
            minLength: 1,
            maxLength: 200,
            description: 'Visible field name or current eNN ref from browser_observe.',
          }),
          value: Type.String({
            maxLength: 4096,
            description:
              'Text to enter, offered option to commit, ISO date, or ISO date range written ' +
              'as from..to or from,to. Credentials are not accepted.',
          }),
          pick_suggestion: Type.Optional(
            Type.Boolean({
              description:
                'Deprecated advisory flag. Typeahead detection and suggestion commitment are ' +
                'automatic whether this is true, false, or omitted.',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 10,
        description: 'Fields to apply in order; processing stops at the first failure.',
      },
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserFormFillParams>;
type FieldSpec = Params['fields'][number];

/** Verified per-field result returned to the model. */
export interface AppliedFormField {
  readonly field: string;
  readonly ref: string;
  readonly driver: string;
  readonly action: 'filled' | 'picked_option' | 'picked_date';
  readonly committed: string;
}

/** Build the ordered whole-form tool. */
export function browserFormFillSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserFormFillParams> {
  return {
    name: 'browser_form_fill',
    label: 'Browser Form Fill',
    description:
      'Fill a whole form in one ordered call, automatically delegating text, date/date-range, ' +
      'and offered-choice controls to the same verified widget drivers as the dedicated pick ' +
      'tools. Use browser_pick_date or browser_pick_option for one control. Do NOT use this for ' +
      'credentials or submission; use browser_fill with secret_ref for credentials and ' +
      'browser_click for the submit control.',
    parameters: BrowserFormFillParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runFormFill(params, ctx.services),
  };
}

async function runFormFill(params: Params, services: RunServices): Promise<DomainResult> {
  for (const spec of params.fields) {
    if (SECRET_SHAPE.test(spec.value)) {
      return {
        ok: false,
        errorCode: 'SECRET_SHAPED_LITERAL',
        message:
          `The value for "${spec.field}" is credential-shaped. browser_form_fill never handles ` +
          'credentials; use browser_fill with a secret_ref.',
        retryable: true,
      };
    }
  }
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  const applied: AppliedFormField[] = [];
  for (const spec of params.fields) {
    const outcome = await applyField(spec, controller, services);
    if (isDomainFailure(outcome)) {
      return { ...outcome, details: withApplied(outcome.details, applied) };
    }
    applied.push(outcome);
  }
  const observation = await controller.observe();
  return {
    ok: true,
    model: {
      ...modelObservation(observation),
      applied,
      note: 'Nothing was submitted. Activate the submit/search control with browser_click.',
    },
    details: { fields: applied.length },
  };
}

async function applyField(
  spec: FieldSpec,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<AppliedFormField | DomainFailure> {
  const target = await resolveWidgetTarget(spec.field, controller);
  if (isDomainFailure(target)) return target;
  const port = tracedWidgetPort(controller, services, { field: spec.field, target });
  const registry = createDefaultWidgetRegistry();
  const detected = await registry.detectDriver(port, target);
  if (detected) {
    const intent = intentFor(spec.value);
    let outcome;
    try {
      outcome = await registry.driveWidget(port, target, intent, defaultWidgetBudget(port));
    } catch (error) {
      if (isStaleRefError(error)) return elementReplacedFailure(spec.field, target);
      return browserFailure(error);
    }
    if (!outcome.ok) return mapWidgetFailure(outcome);
    return {
      field: spec.field,
      ref: target.ref,
      driver: outcome.driver,
      action: intent.kind === 'option' ? 'picked_option' : 'picked_date',
      committed: outcome.committed,
    };
  }
  if (!isTextLike(target)) {
    return {
      ok: false,
      errorCode: 'FORM_FIELD_UNSUPPORTED_ROLE',
      message:
        `"${spec.field}" resolved to a ${target.role}, which is not a recognized fillable ` +
        'control. Use browser_click only when the control is an action/toggle.',
      retryable: true,
    };
  }
  try {
    await port.fill(target.ref, spec.value);
  } catch (error) {
    if (isStaleRefError(error)) return elementReplacedFailure(spec.field, target);
    return browserFailure(error);
  }
  return {
    field: spec.field,
    ref: target.ref,
    driver: 'plain-text',
    action: 'filled',
    committed: await readCommitted(port, target),
  };
}

function intentFor(value: string): WidgetIntent {
  const trimmed = value.trim();
  const range = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|,)\s*(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (range) return { kind: 'date_range', from: range[1]!, to: range[2]! };
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return { kind: 'date', date: trimmed };
  return { kind: 'option', value };
}

function isTextLike(target: WidgetTarget): boolean {
  return target.role === 'textbox' || target.role === 'searchbox' || target.role === 'combobox';
}

function withApplied(
  prior: unknown,
  applied: readonly AppliedFormField[],
): Record<string, unknown> {
  const base =
    typeof prior === 'object' && prior !== null && !Array.isArray(prior)
      ? (prior as Record<string, unknown>)
      : {};
  return { ...base, applied };
}
