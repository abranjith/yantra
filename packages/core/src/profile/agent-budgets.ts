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

import { parseAgentDurationMs } from '@yantra/protocol';

// The duration grammar lives in the protocol so browser code shares it (FEAT-067).
export {
  AGENT_DURATION_HINT,
  AGENT_DURATION_PATTERN,
  parseAgentDurationMs,
} from '@yantra/protocol';

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

/** Thinking limits share the duration grammar and require at least ten seconds. */
export function parseAgentTurnTimeoutMs(raw: unknown): number | null {
  const ms = parseAgentDurationMs(raw);
  return ms !== null && ms >= 10_000 ? ms : null;
}
