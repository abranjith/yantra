/**
 * The agent duration grammar (moved from `@yantra/core` profile budgets in
 * FEAT-067 so browser code validates with the same rule). One grammar for
 * every layer that accepts a duration: `profile.yaml`, doctor, the CLI flag
 * parsers and the app composer. The parsers return `null` rather than
 * throwing so each caller raises the failure in its own idiom.
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
 * The CLI's own words for an invalid duration given to `flag`, or null when
 * it is valid. The grammar and the safe-integer ceiling are distinct
 * failures: `99999999999h` and `soon` hear different things.
 */
export function durationProblem(raw: string, flag: string): string | null {
  if (parseAgentDurationMs(raw) !== null) return null;
  return AGENT_DURATION_PATTERN.test(raw.trim())
    ? `${flag} is too large to represent safely in milliseconds.`
    : `${flag} must be ${AGENT_DURATION_HINT}.`;
}
