import type { AttemptRecord } from '../interaction/types.js';
import type { WidgetBudget, WidgetTarget } from '../widgets/types.js';

/** Semantic value requested by a fill caller. */
export type FillIntent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'option'; readonly value: string }
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'date_range'; readonly from: string; readonly to: string }
  | { readonly kind: 'toggle'; readonly checked: boolean }
  | { readonly kind: 'secret'; readonly key: string };

/** Durable caller identity plus the first live target resolved for it. */
export interface FieldIdentity {
  readonly field: string;
  readonly target: WidgetTarget;
}

/** Stable failures produced by the unified fill engine. */
export type FillErrorCode =
  | 'WIDGET_DID_NOT_OPEN'
  | 'WIDGET_TARGET_UNREACHABLE'
  | 'WIDGET_AMBIGUOUS_CHOICE'
  | 'WIDGET_MAPPING_UNSAFE'
  | 'WIDGET_NOT_COMMITTED'
  | 'WIDGET_ELEMENT_REPLACED'
  | 'WIDGET_DISMISS_FAILED'
  | 'WIDGET_RANGE_INCOMPLETE'
  | 'FILL_VALUE_INVALID';

/**
 * How the committed value relates to what the caller asked for.
 *
 * The engine used to report only `committed`, leaving the caller to work out
 * whether a value that differed from the request meant success or failure — and
 * because verification asked the wrong question, it frequently reported failure
 * for a widget that had resolved the request correctly. Naming the relationship
 * is what lets a caller accept "Dallas" for "DFW" and move on.
 */
export type FillResolution =
  /** The control holds what was asked for. */
  | 'exact'
  /** The widget offered exactly one match and that is what was committed. */
  | 'single_offered_match'
  /** Several were offered, one ranked uniquely, and that is what was committed. */
  | 'selected_from_offered'
  /** Nothing was offered; the typed text stands as the value. */
  | 'typed_literal'
  /** The control rewrote the value — an input mask or its own normalization. */
  | 'reformatted';

/** Verified fill result. */
export interface FillSuccess {
  readonly ok: true;
  readonly driver: string;
  readonly committed: string;
  readonly actions: number;
  readonly dismissed: boolean;
  /** What the caller asked for, as it was expressed. */
  readonly requested?: string;
  /** How {@link committed} relates to {@link requested}. */
  readonly resolution?: FillResolution;
  /** What the widget was showing when it chose, capped at ten labels. */
  readonly offered?: readonly string[];
  /**
   * One plain sentence a caller can act on without re-deriving it.
   *
   * Present only when the committed value differs from the request, which is
   * precisely when a caller would otherwise have to guess whether its fill
   * worked.
   */
  readonly note?: string;
  /**
   * What the engine tried on the way to this result.
   *
   * Present whenever recovery ran, so a caller can see that a control needed
   * three entry mechanisms or two drivers — and, on the failure side, avoid
   * repeating work that has already been exhausted.
   */
  readonly attempted?: readonly AttemptRecord[];
}

/** Typed fill failure with model-actionable observed state. */
export interface FillFailure {
  readonly ok: false;
  readonly errorCode: FillErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * The fallback next step for a code with no more specific context.
 *
 * These are the generic answers. Where the engine knows *why* a code was
 * produced it composes something better in {@link hintFor} — the run that
 * motivated this work received the same `WIDGET_NOT_COMMITTED` sentence for
 * four unrelated causes and learned nothing from any of them.
 */
export const FILL_FAILURE_HINTS: Readonly<Record<FillErrorCode, string>> = {
  WIDGET_DID_NOT_OPEN:
    'The control did not open a picker. Re-observe and check it is the field you meant; if it is a plain text box, pass the value as text.',
  WIDGET_TARGET_UNREACHABLE:
    'The value is not offered by this widget. Check details.displayedMonths or details.offered for what it does accept, and use one of those.',
  WIDGET_AMBIGUOUS_CHOICE:
    'Two or more offered choices match equally. Re-issue this call with the full text of the one you want from details.offered.',
  WIDGET_MAPPING_UNSAFE:
    'The calendar disagrees with its own weekday headers, so no date was clicked. Do not click day cells by hand — report the gap instead.',
  WIDGET_NOT_COMMITTED:
    'The widget did not accept the value. Re-observe to see the current state; a different field may hold the value you want.',
  WIDGET_ELEMENT_REPLACED:
    'The page replaced this control repeatedly while it was being operated, and re-acquiring it did not settle. Re-observe and address the field by a more specific visible name.',
  WIDGET_DISMISS_FAILED:
    'The value is set but an overlay is still open and may block the page. Press on with the next action; if a click reports the element is hidden, re-observe first.',
  WIDGET_RANGE_INCOMPLETE:
    'This picker commits a date range as one unit, so half a range is discarded and the page was left unchanged. Send both ends in a single call — one field with the value "<from>..<to>", or both fields in one browser_fill_form.',
  FILL_VALUE_INVALID:
    'The value is malformed. Dates are ISO YYYY-MM-DD, a range is from..to, and a checkbox takes "checked" or "unchecked".',
};

/**
 * The most specific next step the observed state supports.
 *
 * Ordered most-informative first. `offered` is the strongest signal there is —
 * the widget has said in its own words what it will accept — so it outranks
 * anything derived from the code alone. `attempted` is next, because a caller
 * that repeats exhausted recovery wastes a turn on work that already failed.
 */
export function hintFor(
  errorCode: FillErrorCode,
  details: Readonly<Record<string, unknown>>,
): string {
  const offered = Array.isArray(details.offered)
    ? details.offered.filter((entry): entry is string => typeof entry === 'string')
    : [];
  if (offered.length > 0) {
    return (
      `The widget is offering: ${offered.map((entry) => `"${entry}"`).join(', ')}. ` +
      'Re-issue this call with one of those strings exactly as written.'
    );
  }
  const attempted = Array.isArray(details.attempted) ? details.attempted : [];
  if (attempted.length > 1) {
    const strategies = attempted
      .map((record) =>
        typeof record === 'object' && record !== null && 'strategy' in record
          ? String((record as { readonly strategy: unknown }).strategy)
          : '',
      )
      .filter(Boolean);
    return (
      `Already tried, without success: ${strategies.join(', ')}. ` +
      'Do not repeat those; re-observe and address a different control, or report the gap.'
    );
  }
  if (errorCode === 'WIDGET_NOT_COMMITTED' && typeof details.observed === 'string') {
    return details.observed.length > 0
      ? `The control currently holds "${details.observed}". Re-observe before concluding the field is empty; a different field may hold the value you want.`
      : 'The control is empty after the attempt. Re-observe and check it is the field you meant.';
  }
  return FILL_FAILURE_HINTS[errorCode];
}

/** Result of parsing or deterministically applying a fill. */
export type FillOutcome = FillSuccess | FillFailure;

/** Bounds accepted by the fill engine; shared with the widget drivers. */
export type FillBudget = WidgetBudget;

/**
 * Construct a fully populated typed fill failure.
 *
 * The hint is derived from the observed state rather than looked up by code, so
 * two failures with the same code and different causes read differently. A
 * caller-supplied `details.hint` still wins.
 */
export function fillFailure(
  errorCode: FillErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  retryable = true,
): FillFailure {
  return {
    ok: false,
    errorCode,
    message,
    retryable,
    details: { hint: hintFor(errorCode, details), ...details },
  };
}
