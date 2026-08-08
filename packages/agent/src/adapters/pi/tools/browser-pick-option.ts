import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { runWidgetIntent, SECRET_SHAPE } from './browser-widget-common.js';

const BrowserPickOptionParams = Type.Object(
  {
    field: Type.String({
      minLength: 1,
      maxLength: 200,
      description: 'Visible field name or current eNN ref from browser_observe.',
    }),
    value: Type.String({
      minLength: 1,
      maxLength: 4096,
      description: 'The offered choice to commit. Credentials are not accepted.',
    }),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserPickOptionParams>;

/** Build the single-control semantic option picker. */
export function browserPickOptionSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserPickOptionParams> {
  return {
    name: 'browser_pick_option',
    label: 'Browser Pick Option',
    description:
      'Choose one offered value from a dropdown, autocomplete, listbox, radio group, or tab ' +
      'and return the verified committed value. Use it for a single choice control. Do NOT use ' +
      'it to fill a whole form (browser_form_fill), activate a command (browser_click), enter ' +
      'plain free text (browser_fill), or handle credentials.',
    parameters: BrowserPickOptionParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runPickOption(params, ctx.services),
  };
}

async function runPickOption(params: Params, services: RunServices): Promise<DomainResult> {
  if (SECRET_SHAPE.test(params.value)) {
    return {
      ok: false,
      errorCode: 'SECRET_SHAPED_LITERAL',
      message: 'browser_pick_option never handles credentials; use browser_fill with a secret_ref.',
      retryable: true,
    };
  }
  return runWidgetIntent(params.field, { kind: 'option', value: params.value }, 'option', services);
}
