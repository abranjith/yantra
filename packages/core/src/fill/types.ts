import type { AgentBrowserObservation } from '../browser/agent-controller.js';
import type { AttemptRecord, InteractionFailureCause } from '../interaction/types.js';
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
  /**
   * The observation `target` was resolved from, when the caller still has it.
   *
   * This is the before-picture the WHERE rung needs, and a caller that resolved
   * a field name already took it — so passing it makes editee resolution free
   * on the ordinary path and one observation on the delegated one. Omitting it
   * is safe; the rung takes its own baseline where it is worth having.
   */
  readonly observation?: AgentBrowserObservation;
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
   * The control the drive re-targeted to, when the page routed the edit away.
   *
   * Present only when the addressed control was not the one the page edits — a
   * trigger that opens an overlay and forwards keystrokes to the overlay's own
   * input. Reporting the substitution is what stops a caller concluding, from a
   * control that stayed empty, that its fill did not land.
   */
  readonly editee?: {
    readonly ref: string;
    readonly name: string;
    readonly role: string;
  };
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
 * Why a fill failed, as distinct from what the failure is called.
 *
 * Re-exported from the shared interaction vocabulary so the widget layer, which
 * cannot import this module, names causes with exactly the same words.
 */
export type FillCause = InteractionFailureCause;

/** One entry in the failure table: the advice, and what makes it honest. */
export interface FailureTemplate {
  /** Catalog surface owning this message. */
  readonly surface: 'fill';
  /** The one next step, composed from the details this entry declares. */
  readonly hint: (details: Readonly<Record<string, unknown>>) => string;
  /**
   * The detail keys the wording refers to.
   *
   * Declared rather than assumed, and asserted: a hint saying "check
   * details.displayedMonths" on a failure carrying no months is the exact bug
   * this table replaces, and it was possible only because the hint was inferred
   * from whichever keys happened to be present.
   */
  readonly requiredDetails: readonly string[];
  /**
   * The exported engine function that makes the advice actionable.
   *
   * `null` only for advice that asks the caller to *observe* rather than to
   * retry. A hint that names a move the engine has no path for steers the
   * caller into a dead end — telling it to re-issue with a full offered label
   * cost the motivating run 13.9 seconds and a failed call — so every retry
   * hint declares the capability it depends on, and a test asserts that
   * capability is a real export.
   */
  readonly capability: string | null;
  /** Resolver used for the declared capability. */
  readonly capabilityKind: 'engine' | null;
}

type FailureTemplateDefinition = Omit<FailureTemplate, 'surface' | 'capabilityKind'>;

/** The nested table: each code declares only the causes it can produce. */
export type FailureTemplateTable = Readonly<
  Record<FillErrorCode, Partial<Record<FillCause, FailureTemplate>>>
>;
type FailureTemplateDefinitionTable = Readonly<
  Record<FillErrorCode, Partial<Record<FillCause, FailureTemplateDefinition>>>
>;

/** Render one detail value as quoted text, flattening a list of labels. */
function quoted(details: Readonly<Record<string, unknown>>, key: string): string {
  const value = details[key];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => `"${entry}"`)
      .join(', ');
  }
  // Only primitives are ever interpolated: a hint that stringified an object
  // would read "[object Object]", which is worse than no advice at all.
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? `"${String(value)}"`
    : '""';
}

/**
 * Hint and required details, selected together by `(code, cause)`.
 *
 * **Nested per code, never a flat cross-product.** A flat map over every
 * code-and-cause pair would demand all of them, most nonsense — `FILL_VALUE_INVALID`
 * cannot be caused by a picker failing to open — and being made to write prose
 * for all of them guarantees the near-duplicates the invariant test exists to
 * forbid. Each code declares what it can actually produce, and
 * {@link fillFailure} is typed so a pair with no entry is a compile error
 * rather than a generic sentence.
 *
 * **`reason` is a reserved detail key.** `classifyFailure` overrides the code
 * table on `details.reason === 'budget' | 'disabled'`, deliberately:
 * `WIDGET_NOT_COMMITTED` is transient, so a budget-exhausted one is terminal
 * *only* by that key. Every template preserves `reason` verbatim; dropping or
 * renaming it would make budget failures retryable and loop them to the attempt
 * bound, which is precisely what the attempt runner exists to prevent.
 */
const FAILURE_TEMPLATE_DEFINITIONS = {
  WIDGET_DID_NOT_OPEN: {
    'picker-did-not-open': {
      hint: () =>
        'No picker appeared within the wait. Re-observe and confirm this is the control you meant; if it is a plain text box, send the value as text instead.',
      requiredDetails: [],
      capability: null,
    },
  },
  WIDGET_TARGET_UNREACHABLE: {
    'driver-not-recognized': {
      hint: () =>
        'This control was opened and what appeared is not a widget any driver can operate. Re-observe and address the control that carries the value, or report the gap.',
      requiredDetails: [],
      capability: 'probeOpen',
    },
    'picker-did-not-open': {
      hint: () =>
        'Clicking this control revealed no container at all, so there is nothing to operate. Re-observe and address whichever control carries the value.',
      requiredDetails: ['containerResolved'],
      capability: 'probeOpen',
    },
    'value-not-offered': {
      hint: (details) =>
        `This widget accepts only what it offers: ${quoted(details, 'offered')}. Re-issue this call with one of those strings exactly as written.`,
      requiredDetails: ['offered'],
      capability: 'selectByOfferedLabel',
    },
    'no-suggestion-matched': {
      hint: (details) =>
        `Nothing offered matched, and the control discarded the typed text when the list closed, so it will not hold a free-text value. Re-issue with one of ${quoted(details, 'offered')} exactly as written.`,
      requiredDetails: ['offered'],
      capability: 'selectByOfferedLabel',
    },
    'date-not-reachable': {
      hint: (details) =>
        `The calendar was paged and does not offer that date; it is showing ${quoted(details, 'displayedMonths')}. Ask for a date one of those covers, or report the gap.`,
      requiredDetails: ['displayedMonths'],
      capability: null,
    },
    'intent-incompatible': {
      hint: () =>
        'This control cannot take a value of that kind at all. Re-observe and address the control that carries it, or send the value in the form the control expects.',
      requiredDetails: [],
      capability: null,
    },
    budget: {
      hint: () =>
        'The fill spent its whole allowance without finishing. Re-observe to see how far it got, then set this one field on its own.',
      requiredDetails: ['reason'],
      capability: null,
    },
  },
  WIDGET_AMBIGUOUS_CHOICE: {
    'several-matched-equally': {
      hint: (details) =>
        `Two or more offered choices match equally well, and choosing between them is yours to do: ${quoted(details, 'offered')}. Re-issue this call with one of those strings exactly as written.`,
      requiredDetails: ['offered'],
      capability: 'selectByOfferedLabel',
    },
  },
  WIDGET_MAPPING_UNSAFE: {
    'mapping-unsafe': {
      hint: () =>
        'The calendar disagrees with its own weekday headers, so no day cell was clicked. Do not click day cells by hand — report the gap instead.',
      requiredDetails: [],
      capability: null,
    },
  },
  WIDGET_NOT_COMMITTED: {
    'keystrokes-landed-elsewhere': {
      hint: (details) =>
        `The page routed the typed value into ${quoted(details, 'editee')} instead, and it landed there. Address that control directly, or re-observe to see where the value now is.`,
      requiredDetails: ['editee'],
      capability: 'locateEditee',
    },
    'typing-exhausted': {
      hint: () =>
        'Every way of entering text was tried against this control and it kept none of them; details.attempted names each one. Do not repeat those — re-observe and address a different control, or report the gap.',
      requiredDetails: ['attempted'],
      capability: null,
    },
    'control-refused-value': {
      hint: (details) =>
        `The control holds ${quoted(details, 'observed')} rather than what was sent. Re-observe before concluding the field is empty; another control may already carry the value you wanted.`,
      requiredDetails: ['observed'],
      capability: null,
    },
    'value-rejected-on-release': {
      hint: () =>
        'The value was showing while the widget was open and the page did not keep it once the widget closed. Send everything this widget commits together in a single call.',
      requiredDetails: [],
      capability: null,
    },
    budget: {
      hint: (details) =>
        `The fill ran out of time before the value settled; the control held ${quoted(details, 'observed')} when it stopped. Re-observe, then set this one field on its own.`,
      requiredDetails: ['reason', 'observed'],
      capability: null,
    },
  },
  WIDGET_ELEMENT_REPLACED: {
    'element-replaced': {
      hint: () =>
        'The page replaced this control repeatedly while it was being operated, and re-acquiring it did not settle. Re-observe and address the field by a more specific visible name.',
      requiredDetails: [],
      capability: null,
    },
  },
  WIDGET_DISMISS_FAILED: {
    'overlay-still-open': {
      hint: () =>
        'The value is set but an overlay is still open and may block the page. Press on with the next action; if a click reports the element is hidden, re-observe first.',
      requiredDetails: [],
      capability: null,
    },
  },
  WIDGET_RANGE_INCOMPLETE: {
    'range-half-discarded': {
      hint: (details) =>
        `This picker commits a date range as one unit, so half a range is discarded and the page is left unchanged. Send both ends together — one field with the value "<from>..<to>", or this field and ${quoted(details, 'partner')} in one browser_fill_form.`,
      requiredDetails: ['partner'],
      capability: null,
    },
  },
  FILL_VALUE_INVALID: {
    'value-malformed': {
      hint: () =>
        'The value is malformed. Dates are ISO YYYY-MM-DD, a range is from..to, and a checkbox takes "checked" or "unchecked".',
      requiredDetails: [],
      capability: null,
    },
  },
} as const satisfies FailureTemplateDefinitionTable;

/** Fill templates enriched with their catalog surface and capability resolver. */
export const FAILURE_TEMPLATES = attachFailureMetadata(FAILURE_TEMPLATE_DEFINITIONS);

function attachFailureMetadata<const Table extends FailureTemplateDefinitionTable>(
  definitions: Table,
): {
  readonly [Code in keyof Table]: {
    readonly [Cause in keyof Table[Code]]: Table[Code][Cause] & {
      readonly surface: 'fill';
      readonly capabilityKind: Table[Code][Cause] extends { readonly capability: string }
        ? 'engine'
        : null;
    };
  };
} {
  const enriched = Object.fromEntries(
    Object.entries(definitions).map(([code, causes]) => [
      code,
      Object.fromEntries(
        Object.entries(causes).map(([cause, template]) => [
          cause,
          {
            ...template,
            surface: 'fill',
            capabilityKind: template.capability === null ? null : 'engine',
          },
        ]),
      ),
    ]),
  );
  return enriched as unknown as {
    readonly [Code in keyof Table]: {
      readonly [Cause in keyof Table[Code]]: Table[Code][Cause] & {
        readonly surface: 'fill';
        readonly capabilityKind: Table[Code][Cause] extends { readonly capability: string }
          ? 'engine'
          : null;
      };
    };
  };
}

/** The causes one error code can actually produce. */
export type CauseFor<Code extends FillErrorCode> = keyof (typeof FAILURE_TEMPLATES)[Code] &
  FillCause;

/**
 * A hint referred to a detail key the payload does not carry.
 *
 * Thrown rather than degraded: dangling advice is the defect this table exists
 * to remove, and every reachable pair is enumerated by the invariant test, so a
 * correct build cannot reach this.
 */
export class DanglingHintError extends Error {
  public readonly code = 'FILL_HINT_DETAILS_MISSING';

  public constructor(
    public readonly errorCode: FillErrorCode,
    public readonly failureCause: FillCause,
    public readonly missing: readonly string[],
  ) {
    super(
      `The ${errorCode}/${failureCause} hint refers to ${missing.join(', ')}, which the failure does not carry.`,
    );
    this.name = 'DanglingHintError';
  }
}

/** The template for one pair, or null when the code cannot produce that cause. */
export function templateFor(errorCode: FillErrorCode, cause: FillCause): FailureTemplate | null {
  const forCode: Partial<Record<FillCause, FailureTemplate>> = FAILURE_TEMPLATES[errorCode];
  return forCode[cause] ?? null;
}

/** Detail keys a pair's wording refers to but the payload does not carry. */
export function missingHintDetails(
  errorCode: FillErrorCode,
  cause: FillCause,
  details: Readonly<Record<string, unknown>>,
): readonly string[] {
  const template = templateFor(errorCode, cause);
  if (!template) return [];
  return template.requiredDetails.filter(
    (key) => details[key] === undefined || details[key] === null,
  );
}

/**
 * The one next step for this failure, selected by `(code, cause)`.
 *
 * There is deliberately **no per-code fallback sentence**. A pair with no
 * template cannot be constructed — {@link fillFailure} will not type-check —
 * and that is what stops a generic string standing in for advice nobody wrote.
 */
export function hintFor(
  errorCode: FillErrorCode,
  cause: FillCause,
  details: Readonly<Record<string, unknown>>,
): string {
  const template = templateFor(errorCode, cause);
  if (!template) throw new DanglingHintError(errorCode, cause, ['a template for this pair']);
  const missing = missingHintDetails(errorCode, cause, details);
  if (missing.length > 0) throw new DanglingHintError(errorCode, cause, missing);
  return template.hint(details);
}

/** Result of parsing or deterministically applying a fill. */
export type FillOutcome = FillSuccess | FillFailure;

/** Bounds accepted by the fill engine; shared with the widget drivers. */
export type FillBudget = WidgetBudget;

/**
 * Construct a fully populated typed fill failure.
 *
 * `cause` selects the template **and is then dropped**: it never appears in the
 * emitted failure, so the tool seam and the `tool-calls.jsonl` projection stay
 * byte-compatible with what they carried before causes existed. The model
 * continues to see `error_code`, a cause-specific `message`, and `details`.
 *
 * The generic signature is the enforcement: `CauseFor<Code>` admits only the
 * causes that code declares, so a pair with no template is a compile error.
 */
export function fillFailure<Code extends FillErrorCode>(
  errorCode: Code,
  cause: CauseFor<Code>,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  retryable = true,
): FillFailure {
  return {
    ok: false,
    errorCode,
    message,
    retryable,
    details: { hint: hintFor(errorCode, cause, details), ...details },
  };
}
