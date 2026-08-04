/**
 * The `yantra init` sensitive-context questionnaire.
 *
 * Lives in its own module, with its `ask` boundary injectable, so the whole
 * flow is testable without spawning a terminal — the same
 * injectable-`choose` pattern `template-ref.ts` uses for ambiguous tags.
 *
 * Only *sensitive* facts are asked about. The current date, timezone, and
 * locale tag are host-environment facts, not personal data: they are always
 * supplied to the agent and are deliberately not grants, so they are not
 * questions here either.
 *
 * Cancelling (Ctrl-C / Esc) is not an error — `prompts` returns an empty
 * answer, and the collector falls back to the built-in defaults, which are
 * behavior-preserving.
 */

import type { AmbientGrants } from '@yantra/core';
import prompts from 'prompts';

/** The answers collected from the user, ready to merge into a profile. */
export interface ContextGrantAnswers {
  /** The user's grants over sensitive ambient facts. */
  readonly grants: AmbientGrants;
  /** The location value, or `null` when not granted or left blank. */
  readonly city: string | null;
}

/** Injectable boundaries for deterministic questionnaire tests. */
export interface ContextGrantDeps {
  /** Asks a yes/no question; `null` means the user cancelled. */
  readonly confirm?: (message: string) => Promise<boolean | null>;
  /** Asks a free-text question; `null` means cancelled, `''` means skipped. */
  readonly text?: (message: string) => Promise<string | null>;
}

const LOCATION_QUESTION =
  'Share your location with the agent? Without it, Yantra will ask you to name a ' +
  "location in queries like 'hotels near me' rather than guessing one.";

const CITY_QUESTION = 'City or area (e.g. Naperville, IL) — leave blank to set later';

/** The behavior-preserving answers used when prompting is skipped or cancelled. */
export function defaultContextGrantAnswers(): ContextGrantAnswers {
  return { grants: { location: true }, city: null };
}

/**
 * Runs the grant questionnaire.
 *
 * Declining the location grant skips the city question entirely — asking for a
 * value the user just refused to share would be both pointless and hostile.
 *
 * @param deps - Injectable prompt boundaries; defaults to the real terminal.
 * @returns The collected grants and city, or the defaults on cancellation.
 */
export async function collectContextGrants(
  deps: ContextGrantDeps = {},
): Promise<ContextGrantAnswers> {
  const confirm = deps.confirm ?? promptConfirm;
  const text = deps.text ?? promptText;

  const shareLocation = await confirm(LOCATION_QUESTION);
  if (shareLocation === null) {
    return defaultContextGrantAnswers();
  }
  if (!shareLocation) {
    return { grants: { location: false }, city: null };
  }

  const city = await text(CITY_QUESTION);
  const trimmed = city === null ? '' : city.trim();
  return { grants: { location: true }, city: trimmed.length > 0 ? trimmed : null };
}

async function promptConfirm(message: string): Promise<boolean | null> {
  const answer = (await prompts({
    type: 'confirm',
    name: 'value',
    message,
    initial: true,
  })) as { value?: unknown };
  return typeof answer.value === 'boolean' ? answer.value : null;
}

async function promptText(message: string): Promise<string | null> {
  const answer = (await prompts({ type: 'text', name: 'value', message })) as { value?: unknown };
  return typeof answer.value === 'string' ? answer.value : null;
}
