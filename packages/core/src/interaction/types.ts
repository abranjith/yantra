/**
 * Shared vocabulary for bounded, self-reporting browser interaction.
 *
 * The engine already retried, re-acquired, and re-read far more than its
 * results ever admitted, so a caller that received a failure could not tell
 * recovered-and-still-failed from never-tried. That gap is what turned a single
 * uncooperative control into a whole run of blind retries. Every primitive in
 * this module therefore records what it did, and every result carries that
 * record outward.
 */

/**
 * Why a failure happened, as distinct from what it is called.
 *
 * The stable error code is the programmatic contract and does not change. This
 * is the internal discriminator beside it, and it exists because one code
 * covers several unrelated situations: a control that took no keystrokes at
 * all, one that took them and cleared them on release, and one that routed them
 * into a different node are all `WIDGET_NOT_COMMITTED`, and the run that
 * motivated this work received the same sentence for every one of them.
 *
 * Selecting message, hint and required details together by `(code, cause)` is
 * what replaces inferring a hint from whichever detail keys happen to be
 * present — the arrangement that told an agent to "check details.displayedMonths"
 * on a failure carrying no months.
 *
 * **Never serialized.** It selects a template and is then dropped; the model
 * continues to see only `error_code`, `message`, and `details`.
 */
export type InteractionFailureCause =
  /** The editee probe found the keystrokes in a different live control. */
  | 'keystrokes-landed-elsewhere'
  /** The control cleared the value when the widget closed. */
  | 'value-rejected-on-release'
  /** The control simply does not hold what it was given. */
  | 'control-refused-value'
  /** A list was offered, nothing matched, and the text did not stand. */
  | 'no-suggestion-matched'
  /** The opened container exposes controls but no declared selectable options. */
  | 'no-options-offered'
  /** Several offers ranked equally; the choice belongs to the caller. */
  | 'several-matched-equally'
  /** Every entry mechanism ran against the confirmed editee. */
  | 'typing-exhausted'
  /** No driver above threshold, and the open probe did not change that. */
  | 'driver-not-recognized'
  /** A driver ran and the value is not among what the widget offers. */
  | 'value-not-offered'
  /** A calendar was paged and the requested date is not reachable in it. */
  | 'date-not-reachable'
  /** A trigger exposed no container within the wait. */
  | 'picker-did-not-open'
  /** The page re-mounted the control faster than re-acquisition. */
  | 'element-replaced'
  /** The value landed but the widget could not be released. */
  | 'overlay-still-open'
  /** Half a range was discarded by a picker that commits the pair. */
  | 'range-half-discarded'
  /** A calendar disagrees with its own weekday headers. */
  | 'mapping-unsafe'
  /** The requested value is not a shape this control can take. */
  | 'value-malformed'
  /** The control cannot accept this kind of value at all. */
  | 'intent-incompatible'
  /** A bound was reached before the work completed. */
  | 'budget';

/**
 * Whether a failure could plausibly differ on a second identical attempt.
 *
 * `terminal` is the safe default for anything unrecognized: a code nobody has
 * classified must never be retried on the assumption that it might pass, or an
 * unknown failure becomes an unbounded loop.
 */
export type AttemptDisposition = 'transient' | 'terminal';

/**
 * Which question an attempt varied.
 *
 * Recovery that only ever varies *how* it types can never escape a control that
 * was never the editee, or a widget that will not answer the query it was
 * given. Naming the axis on the record is what makes "which axis did this run
 * waste its time on" answerable straight from `tool-calls.jsonl`, instead of
 * being a property of prose nobody can query.
 *
 * - `where` — is this live node the one the page actually edits?
 * - `what` — what query shape will this widget answer?
 * - `how` — typing mechanics, pacing, native setters, driver choice.
 */
export type InteractionAxis = 'where' | 'what' | 'how';

/** One attempt made while carrying out a single caller-visible operation. */
export interface AttemptRecord {
  /** 1-based ordinal within the operation. */
  readonly attempt: number;
  /**
   * What was tried, in caller-meaningful terms — `"overtype"`,
   * `"clear-then-type"`, `"driver:calendar-grid"`, `"re-resolve-ref"`.
   * Never a site name; see the no-website-specific-logic rule.
   */
  readonly strategy: string;
  /**
   * Which question this attempt varied.
   *
   * `how` is the default because every rung that existed before the axes were
   * named is one: a different way of typing into the same node with the same
   * query.
   */
  readonly axis: InteractionAxis;
  /** The stable failure code, or null on the attempt that succeeded. */
  readonly errorCode: string | null;
  /** Wall-clock spent on this attempt alone. */
  readonly elapsedMs: number;
  /** One short clause of observed detail, when the attempt had one to add. */
  readonly detail?: string;
}

/** The ordered record of every attempt one operation made. */
export interface AttemptLedger {
  readonly records: readonly AttemptRecord[];
}

/** An empty ledger, for operations that completed without incident. */
export const EMPTY_LEDGER: AttemptLedger = { records: [] };

/** Build a ledger from records, normalizing the readonly shape. */
export function ledgerOf(records: readonly AttemptRecord[]): AttemptLedger {
  return { records: [...records] };
}

/** True when the ledger holds more than the single successful attempt. */
export function ledgerIsInteresting(ledger: AttemptLedger): boolean {
  return ledger.records.length > 1;
}

/**
 * The shared text normalization used by every matcher in this module.
 *
 * Case-folded, punctuation-collapsed, whitespace-squeezed. Kept in one place so
 * field resolution, option ranking, and commit verification cannot drift into
 * three subtly different ideas of what "the same text" means.
 */
export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Await a real timer; injectable everywhere so tests never sleep. */
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
