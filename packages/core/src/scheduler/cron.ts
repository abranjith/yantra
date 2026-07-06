/**
 * Cron helpers — a thin wrapper over `croner` (FEAT-021, plan §3).
 *
 * All cron parsing, validation, and next-fire computation is delegated to
 * `croner` (chosen for TS-native types and DST correctness). This module is the
 * single seam the rest of the scheduler talks to, so croner stays behind one
 * import and next-fire logic is testable with a fixed clock.
 *
 * Timezone is the host's local zone (feature spec §2), stored implicitly — a
 * schedule fires on the machine that registered it.
 */

import { Cron } from 'croner';

/** Result of {@link validateCron}. */
export type CronValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates a cron expression by attempting to parse it with croner.
 *
 * @param expr - The cron expression to validate (5- or 6-field).
 * @returns `{ ok: true }` when parseable, else `{ ok: false, reason }`.
 *
 * @example
 * validateCron('*\/5 * * * *'); // { ok: true }
 * validateCron('not a cron');   // { ok: false, reason: '...' }
 */
export function validateCron(expr: string): CronValidation {
  const trimmed = expr.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'cron expression is empty' };
  }
  try {
    // Construct without scheduling a callback so no timer is created; `paused`
    // keeps croner from arming an internal job.
    new Cron(trimmed, { paused: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Computes the next fire time strictly after `from` for a cron expression.
 *
 * @param expr - A cron expression already known to be valid.
 * @param from - The reference instant (defaults to now). The result is the
 *   first scheduled time strictly greater than `from`.
 * @returns The next fire `Date`, or null when the expression never fires again
 *   (e.g. a one-shot cron whose only time is in the past).
 * @throws {Error} When `expr` is not a valid cron expression.
 */
export function nextFire(expr: string, from: Date = new Date()): Date | null {
  const cron = new Cron(expr.trim(), { paused: true });
  return cron.nextRun(from);
}

/**
 * Computes the next fire time as an ISO string, or null.
 *
 * Convenience wrapper over {@link nextFire} for persisting the advisory
 * `next_fire_at` cache column.
 */
export function nextFireIso(expr: string, from: Date = new Date()): string | null {
  const next = nextFire(expr, from);
  return next === null ? null : next.toISOString();
}
