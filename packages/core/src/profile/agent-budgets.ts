/**
 * The canonical agent budget-value vocabulary.
 *
 * One duration grammar and one count grammar, in one module, shared by every
 * layer that accepts a budget from a user: the `profile.yaml` schema
 * (`packages/core/src/profile/profile-file.ts`), the offline doctor checks
 * (`packages/agent/src/runtime/diagnostics.ts`), and the CLI flag parsers
 * (`apps/cli/src/agent-options.ts`).
 *
 * The parsers return `null` rather than throwing so each caller can raise the
 * failure in its own idiom — a Zod issue, a doctor check, or a typed
 * `CommanderError` — without any of them re-deriving what "valid" means.
 * Duplicating the grammar is how a value that `profile.yaml` rejects at write
 * time slips in through the environment and is reported healthy by doctor.
 */

/**
 * A positive duration: bare milliseconds, or an integer with a `ms`/`s`/`m`/`h`
 * unit. Fractional, negative, zero, blank, and unknown-unit values are invalid.
 */
export const AGENT_DURATION_PATTERN = /^[1-9]\d*(?:ms|s|m|h)?$/u;

/** Human-facing description of {@link AGENT_DURATION_PATTERN}, for error text. */
export const AGENT_DURATION_HINT = 'a positive duration such as 15m, 900s, or 900000';

const DURATION_WITH_UNIT = /^([1-9]\d*)(ms|s|m|h)?$/u;
const UNIT_MULTIPLIER: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * Parses a duration into whole milliseconds.
 *
 * @param raw - Candidate duration. Surrounding whitespace is tolerated.
 * @returns The duration in milliseconds, or `null` when the value does not
 *   match the grammar or cannot be represented as a safe integer.
 */
export function parseAgentDurationMs(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const match = DURATION_WITH_UNIT.exec(String(raw).trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  const milliseconds = amount * (match[2] === undefined ? 1 : (UNIT_MULTIPLIER[match[2]] ?? 1));
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

/**
 * Parses a budget count (`--max-tokens`, `--tool-retries`).
 *
 * Only a plain integer literal or a `number` is accepted; exponent forms and
 * blank strings are rejected so an empty environment variable cannot coerce to
 * zero.
 *
 * @param value - Candidate count, as supplied by a flag, environment variable,
 *   or `profile.yaml`.
 * @param options.allowZero - Whether `0` is a legal value (retries, not tokens).
 * @returns The count, or `null` when the value is not a valid safe integer.
 */
export function parseAgentCount(
  value: unknown,
  options: { readonly allowZero: boolean },
): number | null {
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
    parsed = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isSafeInteger(parsed)) return null;
  if (parsed < 0) return null;
  if (parsed === 0 && !options.allowZero) return null;
  return parsed;
}

/**
 * Renders whole milliseconds back into the most compact form the duration
 * grammar accepts, so reported defaults read the way a user would type them.
 */
export function formatAgentDuration(milliseconds: number): string {
  if (milliseconds % 3_600_000 === 0) return `${milliseconds / 3_600_000}h`;
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}
