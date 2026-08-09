import { parseFillValue, resolveDatePair, type WidgetTarget } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  browserController,
  browserWidgetPort,
  isDomainFailure,
  mapFillFailure,
  modelObservation,
  resolveFillTarget,
} from './browser-common.js';
import { applyBrowserFill, type AppliedBrowserFill } from './browser-fill-element.js';

const BrowserFillFormParams = Type.Object(
  {
    fields: Type.Array(
      Type.Object(
        {
          field: Type.String({
            minLength: 1,
            maxLength: 200,
            description: 'Visible accessible field name or current eNN ref.',
          }),
          value: Type.String({
            maxLength: 4096,
            description:
              'Non-secret text, offered option, checked state, ISO date, or ISO date range.',
          }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 10,
        description: 'Fields to fill in order; processing stops at the first failure.',
      },
    ),
  },
  { additionalProperties: false },
);

type Params = Static<typeof BrowserFillFormParams>;

/** Build the ordered multi-control fill tool. */
export function browserFillFormSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserFillFormParams> {
  return {
    name: 'browser_fill_form',
    label: 'Browser Fill Form',
    description:
      'Fill an ordered list of non-secret form controls through the same semantic engine as browser_fill_element, including dates, choices, toggles, and suggestions. Use browser_fill_element for a credential. Processing stops at the first failure; do not use this tool to submit the form.',
    parameters: BrowserFillFormParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runFillForm(params, ctx.services),
  };
}

async function runFillForm(params: Params, services: RunServices): Promise<DomainResult> {
  for (const spec of params.fields) {
    const parsed = parseFillValue(spec.value, 'textbox');
    if (!('kind' in parsed)) {
      return { ...mapFillFailure(parsed), details: { ...parsed.details, applied: [] } };
    }
  }
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;
  const plan = await fuseDatePair(params.fields, services);
  const applied: AppliedBrowserFill[] = [];
  for (const spec of plan) {
    const outcome = await applyBrowserFill(spec.field, spec.value, services);
    if (isDomainFailure(outcome)) {
      return {
        ...outcome,
        details: { ...asDetails(outcome.details), applied },
      };
    }
    // A fused range is reported as the one fill it was, listing both field
    // names it accounts for. Emitting a second entry would have to invent a ref
    // for a control that was never driven.
    applied.push(spec.covers.length > 1 ? { ...outcome, covers: spec.covers } : outcome);
  }
  const observation = await controller.observe();
  return {
    ok: true,
    model: {
      applied,
      observation: modelObservation(observation),
      note: 'Nothing was submitted. Activate the submit/search control with browser_click.',
    },
    details: { fields: applied.length },
  };
}

/** One fill to perform, and the caller's field names it accounts for. */
interface PlannedFill {
  readonly field: string;
  readonly value: string;
  readonly covers: readonly string[];
}

/**
 * Collapse the two ends of one date range into a single range fill.
 *
 * A picker that spreads a range over a check-in/check-out pair commits the pair
 * and nothing less: filling one end clears the other, and releasing the widget
 * there discards the choice. Driven as two independent fills the first one can
 * therefore never survive, however carefully it is retried — the caller has to
 * be asking for a range for the widget to have anything it can accept. When a
 * caller sends both ends in one call it *is* asking for a range, so the tool
 * says so rather than taking the request apart and failing on the first half.
 *
 * Fusion needs both ends to be unambiguous, so it applies only when the request
 * holds exactly two dates, the page resolves exactly one control per side, and
 * those controls are the two fields named. Anything else fills in order as
 * before, and a page with a single-date picker is untouched by this.
 */
async function fuseDatePair(
  fields: readonly { readonly field: string; readonly value: string }[],
  services: RunServices,
): Promise<readonly PlannedFill[]> {
  const asIs = fields.map((spec) => ({ ...spec, covers: [spec.field] }));
  const dates = fields.filter((spec) => {
    const parsed = parseFillValue(spec.value, 'textbox');
    return 'kind' in parsed && parsed.kind === 'date';
  });
  if (dates.length !== 2) return asIs;

  const controller = browserController(services);
  if (isDomainFailure(controller)) return asIs;
  const first = await resolveFillTarget(dates[0]!.field, controller);
  if (isDomainFailure(first)) return asIs;
  const pair = await resolveDatePair(browserWidgetPort(controller, services.now), first);
  if (!pair) return asIs;

  const from = dates.find((spec) => names(spec.field, pair.from));
  const to = dates.find((spec) => names(spec.field, pair.to));
  if (!from || !to || from === to) return asIs;
  // A reversed range is the caller's mistake, not something to quietly reorder.
  // Left unfused it is reported by the engine against the field they named.
  if (from.value.trim() > to.value.trim()) return asIs;

  const fused: PlannedFill = {
    field: from.field,
    value: `${from.value.trim()}..${to.value.trim()}`,
    covers: [from.field, to.field],
  };
  // Position is preserved: the range takes the place of the first end named,
  // and any non-date fields keep filling in the order the caller asked for.
  return fields.flatMap((spec) =>
    spec === to ? [] : [spec === from ? fused : { ...spec, covers: [spec.field] }],
  );
}

/** True when a caller's field string denotes this side of the pair. */
function names(field: string, side: WidgetTarget): boolean {
  const wanted = field.trim().toLocaleLowerCase();
  return field === side.ref || side.name.trim().toLocaleLowerCase() === wanted;
}

function asDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
