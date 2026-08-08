import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { runWidgetIntent } from './browser-widget-common.js';

const Field = Type.String({
  minLength: 1,
  maxLength: 200,
  description: 'Visible date-control name or current eNN ref from browser_observe.',
});
const IsoDate = (description: string): ReturnType<typeof Type.String> =>
  Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$', description });

/**
 * The root schema must be a plain object: providers reject a tool whose
 * parameter schema is a top-level union (it serializes to `anyOf` with no
 * `type`, which OpenAI-compatible endpoints refuse outright). The either/or
 * between `date` and `from`+`to` is therefore enforced in {@link runPickDate}
 * rather than by the schema.
 */
const BrowserPickDateParams = Type.Object(
  {
    field: Field,
    date: Type.Optional(
      IsoDate('Single target date (YYYY-MM-DD). Omit it when supplying from and to.'),
    ),
    from: Type.Optional(
      IsoDate('Range start (YYYY-MM-DD). Requires to; omit both when supplying date.'),
    ),
    to: Type.Optional(
      IsoDate('Range end (YYYY-MM-DD), same as or later than from. Requires from.'),
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserPickDateParams>;

/** Build the single-control semantic date/date-range picker. */
export function browserPickDateSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserPickDateParams> {
  return {
    name: 'browser_pick_date',
    label: 'Browser Pick Date',
    description:
      'Set one date or date range on a calendar popup or date text input and return the verified ' +
      'committed value. Supply exactly one form: either date, or the complete from+to pair, in ' +
      'YYYY-MM-DD. Do NOT supply both forms, a half-specified range, or use it for non-date ' +
      'choices (browser_pick_option), whole forms (browser_form_fill), or credentials.',
    parameters: BrowserPickDateParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runPickDate(params, ctx.services),
  };
}

async function runPickDate(params: Params, services: RunServices): Promise<DomainResult> {
  const { date, from, to } = params;

  if (date !== undefined) {
    if (from !== undefined || to !== undefined)
      return shapeError('both a date and a from/to range');
    if (!isValidIsoDate(date)) return invalidDate('date');
    return runWidgetIntent(params.field, { kind: 'date', date }, 'date', services);
  }
  if (from === undefined || to === undefined) {
    if (from === undefined && to === undefined) return shapeError('neither date nor from and to');
    return shapeError(`only \`${from === undefined ? 'to' : 'from'}\``);
  }
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) return invalidDate('from/to');
  if (to < from) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: '`to` must be the same as or later than `from` for a date range.',
      retryable: true,
    };
  }
  return runWidgetIntent(params.field, { kind: 'date_range', from, to }, 'date', services);
}

/** Reject an over- or under-specified call before any page interaction. */
function shapeError(supplied: string): DomainResult {
  return {
    ok: false,
    errorCode: 'INVALID_INPUT',
    message:
      `Supply exactly one form: \`date\` for a single day, or \`from\` and \`to\` together for a ` +
      `range. This call supplied ${supplied}.`,
    retryable: true,
  };
}

function invalidDate(field: string): DomainResult {
  return {
    ok: false,
    errorCode: 'INVALID_INPUT',
    message: `${field} must be a real calendar date in YYYY-MM-DD format (for example 2026-09-06).`,
    retryable: true,
  };
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}
