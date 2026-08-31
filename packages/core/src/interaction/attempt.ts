/**
 * Bounded retry with a ledger.
 *
 * The tools used to push recovery onto the model: a replaced control returned
 * "retry the same call once", which costs a turn to redo work the tool could
 * have finished inline, and which a model frequently answers by abandoning the
 * tool entirely. `withAttempts` moves that loop inside the call and, just as
 * importantly, records it — so a failure that survives recovery can say what
 * was already tried instead of inviting a repeat of it.
 */

import {
  ledgerOf,
  realSleep,
  type AttemptDisposition,
  type AttemptLedger,
  type AttemptRecord,
  type InteractionAxis,
} from './types.js';

/**
 * Failures that a second identical attempt could plausibly resolve.
 *
 * Every entry describes a page that moved underneath the caller rather than a
 * page that answered. `WIDGET_NOT_COMMITTED` is here because a control that has
 * not yet reflected a value is frequently still settling; it is bounded by the
 * attempt count like everything else.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set([
  'WIDGET_ELEMENT_REPLACED',
  'STALE_ELEMENT_REF',
  'ELEMENT_HIDDEN',
  'WIDGET_DID_NOT_OPEN',
  'WIDGET_NOT_COMMITTED',
]);

/**
 * Failures where the page gave a definite answer.
 *
 * Listed explicitly rather than inferred, so adding a code forces a decision.
 * Anything absent from both sets is treated as terminal — see
 * {@link classifyFailure}.
 */
const TERMINAL_CODES: ReadonlySet<string> = new Set([
  'WIDGET_AMBIGUOUS_CHOICE',
  'WIDGET_MAPPING_UNSAFE',
  'WIDGET_RANGE_INCOMPLETE',
  'WIDGET_TARGET_UNREACHABLE',
  'WIDGET_NOT_RECOGNIZED',
  'WIDGET_DISMISS_FAILED',
  'FILL_VALUE_INVALID',
  'SECRET_HOST_MISMATCH',
  'SECRET_RESOLVER_UNAVAILABLE',
  'ELEMENT_DISABLED',
  'OPTION_NOT_FOUND',
  'FORM_FIELD_NOT_FOUND',
  'FORM_FIELD_AMBIGUOUS',
  'BROWSER_UNAVAILABLE',
  'BROWSER_NOT_STARTED',
  'URL_NOT_FROM_EVIDENCE',
  'BUDGET_EXHAUSTED',
]);

/**
 * Decide whether a failure is worth another attempt.
 *
 * Two details override the code itself: an exhausted budget and a disabled
 * target are definite answers whatever code carried them, and retrying either
 * only burns the remaining allowance.
 *
 * An unrecognized code is **terminal**. Defaulting the other way would let any
 * future failure loop silently up to the attempt bound, which is precisely the
 * behavior this module exists to bound.
 */
export function classifyFailure(
  errorCode: string,
  details: Readonly<Record<string, unknown>> = {},
): AttemptDisposition {
  const reason = details.reason;
  if (reason === 'budget' || reason === 'disabled') return 'terminal';
  if (TERMINAL_CODES.has(errorCode)) return 'terminal';
  if (TRANSIENT_CODES.has(errorCode)) return 'transient';
  return 'terminal';
}

/** Result of one attempt: a value, or a caller-typed failure. */
export type AttemptOutcome<TValue, TFailure> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: TFailure };

/** How a failure describes itself in the ledger. */
export interface AttemptDescription {
  readonly errorCode: string;
  readonly detail?: string;
}

/** Bounds and hooks for one {@link withAttempts} run. */
export interface AttemptOptions<TFailure> {
  /** Hard ceiling on attempts, including the first. */
  readonly maxAttempts: number;
  /** Absolute instant past which no further attempt is started. */
  readonly deadlineMs: number;
  /** Pause before each retry; the final entry repeats once exhausted. */
  readonly backoffMs: readonly number[];
  /** Whether a failure is worth retrying. */
  readonly classify: (failure: TFailure) => AttemptDisposition;
  /** How the failure names itself in the ledger. */
  readonly describe: (failure: TFailure) => AttemptDescription;
  /** Injectable clock. */
  readonly now: () => number;
  /** Names the strategy of each attempt; defaults to `attempt-N`. */
  readonly label?: (attempt: number) => string;
  /**
   * Which question each attempt varies; defaults to `how`.
   *
   * Every ladder that predates the axes varies mechanism against one fixed
   * node and one fixed query, so `how` is the honest default rather than a
   * placeholder — a runner that wanted another axis has to say so.
   */
  readonly axis?: (attempt: number) => InteractionAxis;
  /** Injectable delay, so tests never wait on real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A completed attempt sequence and the record of how it went. */
export interface AttemptRun<TValue, TFailure> {
  readonly outcome: AttemptOutcome<TValue, TFailure>;
  readonly ledger: AttemptLedger;
}

/**
 * Run an operation until it succeeds, answers definitely, or runs out of room.
 *
 * The returned failure is always the **last one actually observed**, never a
 * synthesized summary — a caller reading `errorCode` must see what the page
 * really said. The ledger carries the rest.
 */
export async function withAttempts<TValue, TFailure>(
  run: (attempt: number) => Promise<AttemptOutcome<TValue, TFailure>>,
  options: AttemptOptions<TFailure>,
): Promise<AttemptRun<TValue, TFailure>> {
  const sleep = options.sleep ?? realSleep;
  const label = options.label ?? ((attempt: number): string => `attempt-${attempt}`);
  const axisOf = options.axis ?? ((): InteractionAxis => 'how');
  const records: AttemptRecord[] = [];
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts));
  let last: AttemptOutcome<TValue, TFailure> | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = options.now();
    const outcome = await run(attempt);
    last = outcome;

    if (outcome.ok) {
      records.push({
        attempt,
        strategy: label(attempt),
        axis: axisOf(attempt),
        errorCode: null,
        elapsedMs: options.now() - startedAt,
      });
      return { outcome, ledger: ledgerOf(records) };
    }

    const described = options.describe(outcome.failure);
    records.push({
      attempt,
      strategy: label(attempt),
      axis: axisOf(attempt),
      errorCode: described.errorCode,
      elapsedMs: options.now() - startedAt,
      ...(described.detail === undefined ? {} : { detail: described.detail }),
    });

    if (options.classify(outcome.failure) === 'terminal') break;
    if (attempt === maxAttempts) break;

    const pause = backoffFor(options.backoffMs, attempt);
    // The deadline governs whether the *next* attempt may start, pause
    // included: waiting out a backoff only to be cut off mid-attempt spends
    // the caller's remaining time for nothing.
    if (options.now() + pause >= options.deadlineMs) break;
    if (pause > 0) await sleep(pause);
  }

  // `last` is non-null: the loop always runs at least once.
  return { outcome: last!, ledger: ledgerOf(records) };
}

/** The pause before retry `attempt + 1`, repeating the final entry. */
function backoffFor(backoffMs: readonly number[], attempt: number): number {
  if (backoffMs.length === 0) return 0;
  const index = Math.min(attempt - 1, backoffMs.length - 1);
  return Math.max(0, backoffMs[index] ?? 0);
}
