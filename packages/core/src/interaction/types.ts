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
 * Whether a failure could plausibly differ on a second identical attempt.
 *
 * `terminal` is the safe default for anything unrecognized: a code nobody has
 * classified must never be retried on the assumption that it might pass, or an
 * unknown failure becomes an unbounded loop.
 */
export type AttemptDisposition = 'transient' | 'terminal';

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
