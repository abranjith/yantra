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

/** Verified fill result. */
export interface FillSuccess {
  readonly ok: true;
  readonly driver: string;
  readonly committed: string;
  readonly actions: number;
  readonly dismissed: boolean;
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
 * What a caller should do next, per failure code.
 *
 * A typed code and the observed state say what happened; without a next step a
 * model tends to abandon the tool and drive the widget by hand, which is the
 * failure mode these tools exist to remove. Each hint names one concrete
 * action and, where the tool has already exhausted its own recovery, says so —
 * so a retry is only suggested when a retry could plausibly differ.
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
    'The page kept replacing this control while it was being operated. Retry the same call once; if it fails again, re-observe and address the field by a more specific visible name.',
  WIDGET_DISMISS_FAILED:
    'The value is set but an overlay is still open and may block the page. Press on with the next action; if a click reports the element is hidden, re-observe first.',
  WIDGET_RANGE_INCOMPLETE:
    'This picker commits a date range as one unit, so half a range is discarded and the page was left unchanged. Send both ends in a single call — one field with the value "<from>..<to>", or both fields in one browser_fill_form.',
  FILL_VALUE_INVALID:
    'The value is malformed. Dates are ISO YYYY-MM-DD, a range is from..to, and a checkbox takes "checked" or "unchecked".',
};

/** Result of parsing or deterministically applying a fill. */
export type FillOutcome = FillSuccess | FillFailure;

/** Bounds accepted by the fill engine; shared with the widget drivers. */
export type FillBudget = WidgetBudget;

/**
 * Construct a fully populated typed fill failure, carrying the next step for
 * its code unless the caller supplied a more specific one in `details.hint`.
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
    details: { hint: FILL_FAILURE_HINTS[errorCode], ...details },
  };
}
