import { parseFillValue } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import {
  browserController,
  isDomainFailure,
  mapFillFailure,
  modelObservation,
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
  const applied: AppliedBrowserFill[] = [];
  for (const spec of params.fields) {
    const outcome = await applyBrowserFill(spec.field, spec.value, services);
    if (isDomainFailure(outcome)) {
      return {
        ...outcome,
        details: { ...asDetails(outcome.details), applied },
      };
    }
    applied.push(outcome);
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

function asDetails(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
