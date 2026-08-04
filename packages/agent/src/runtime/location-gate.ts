/**
 * The deterministic pre-flight location gate.
 *
 * Some goals cannot be answered without knowing where the user is. When no
 * location is available, the honest outcome is a handoff — but discovering that
 * mid-run means tokens spent, a browser launched, and (as the logged run
 * `20260803T033803Z-do-f1d9f01b` showed) a model that fills the gap by inferring
 * "Chicago" from an `America/Chicago` timezone and publishes a confident answer
 * about the wrong city.
 *
 * So the check runs before the provider session exists: no tokens, no browser,
 * one clear remedy, exit 4.
 *
 * **This is one of two layers, by design.** The phrase list below is
 * deliberately conservative and matches only *self-referential* phrasings, so
 * it under-matches rather than refusing goals it should not. Everything it
 * misses is caught by the second layer — the ambient block's
 * `- user location: not available` marker plus the prompt rule forbidding the
 * model from deriving one. A goal this gate lets through with no location still
 * cannot end in a guessed city; it ends in a model-reported blocker instead.
 */

import type { AmbientGrants, Sanitized } from '@yantra/core';

/**
 * Self-referential location phrases. Each one is meaningless without knowing
 * where the user is, so matching one proves the goal depends on the fact.
 *
 * Bare `closest` / `nearest` are **deliberately excluded**: "the nearest station
 * to Times Square" carries its own anchor and needs nothing from the profile.
 * Adding them would refuse goals that are perfectly answerable.
 */
const LOCATION_PHRASES: readonly string[] = [
  'near me',
  'nearby',
  'close to me',
  'closest to me',
  'nearest to me',
  'around me',
  'next to me',
  'around here',
  'near here',
  'close to here',
  'in my area',
  'my area',
  'my neighborhood',
  'my city',
  'my town',
  'my region',
  'my zip',
  'my location',
  'where i am',
  'where i live',
  'local to me',
];

/** The sensitive ambient facts available to one run. */
export interface AmbientContextView {
  readonly grants: AmbientGrants;
  readonly userLocation: Sanitized<string> | null;
}

/** The handoff payload a blocked run reports. */
export interface LocationHandoff {
  readonly blocker: string;
  readonly safestNextAction: string;
}

/**
 * Whether a goal depends on knowing where the user is.
 *
 * Matching is case- and punctuation-insensitive: the goal is lowercased, every
 * non-alphanumeric character becomes a space, and runs of whitespace collapse,
 * so `"Near-Me"`, `"near me?"`, and `"NEAR  ME"` all match the same phrase.
 * Comparison is space-padded, so a phrase only matches on word boundaries and
 * `"nearbyte"` does not match `nearby`.
 *
 * @param goal - The raw user goal text.
 */
export function requiresUserLocation(goal: string): boolean {
  const normalized = ` ${goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  return LOCATION_PHRASES.some((phrase) => normalized.includes(` ${phrase} `));
}

/**
 * Builds the handoff for a location-dependent goal with no location available,
 * or `null` when the run may proceed.
 *
 * The remedy — unlike the prompt, where denied and unset are deliberately
 * indistinguishable — *does* branch on the grant. The user knows what they
 * chose, and telling someone who turned location off to "set your city" would
 * send them to the wrong setting.
 *
 * @param goal - The raw user goal text.
 * @param ambient - The run's resolved grants and location, if any.
 */
export function locationHandoffFor(
  goal: string,
  ambient: AmbientContextView | null | undefined,
): LocationHandoff | null {
  if (ambient?.userLocation != null && ambient.userLocation.length > 0) {
    return null;
  }
  if (!requiresUserLocation(goal)) {
    return null;
  }
  const granted = ambient?.grants.location ?? true;
  return {
    blocker: 'This goal needs your location, but none is available and Yantra will not infer one.',
    safestNextAction: granted
      ? 'Set one with `yantra prefs set locale.city "<city, state>"`, or name the location in the query.'
      : 'Location sharing is off. Re-enable it with `yantra prefs set context.location true`, or name the location in the query.',
  };
}
