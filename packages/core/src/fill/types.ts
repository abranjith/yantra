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

/** Result of parsing or deterministically applying a fill. */
export type FillOutcome = FillSuccess | FillFailure;

/** Bounds accepted by the fill engine; shared with the widget drivers. */
export type FillBudget = WidgetBudget;

/** Construct a fully populated typed fill failure. */
export function fillFailure(
  errorCode: FillErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  retryable = true,
): FillFailure {
  return { ok: false, errorCode, message, retryable, details };
}
