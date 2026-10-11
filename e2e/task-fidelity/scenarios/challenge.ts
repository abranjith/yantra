/**
 * The shared shape of the two `challenge-interstitial` scenarios.
 *
 * A human-verification page served with HTTP 200 must end as a `blocked`
 * failure: never extracted, never a source, disclosed in a notice. By the
 * signed-off policy (b) — one permitted render in the standard browser — a
 * challenge URL costs exactly two requests: the HTTP read and one render.
 * Today that outcome depends on page size (G10): the small variant happens to
 * escalate and fail extraction; the large one is published as content.
 */

import type { Expectation, Owner } from '../expectations.js';
import { CHALLENGE_PATHS } from '../fixtures/challenge-interstitial.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import { crossCuttingExpectations, fetchStep, publishStep } from './common.js';

export type ChallengeVariant = keyof typeof CHALLENGE_PATHS;

/** The challenge URL for a variant. */
export function challengeUrl(variant: ChallengeVariant): string {
  return `${originOf('challenge-interstitial')}${CHALLENGE_PATHS[variant]}`;
}

/**
 * Build a challenge scenario. Each expectation passes its owner explicitly: a
 * capability that already holds for one variant is `current` there and owned
 * by FEAT-050 for the other, because a pending target may not already pass.
 */
export function challengeScenario(
  variant: ChallengeVariant,
  expectations: readonly (Expectation & { readonly owner: Owner })[],
): Scenario {
  const url = challengeUrl(variant);
  return {
    id: `challenge-${variant}`,
    sites: ['challenge-interstitial'],
    command: 'research',
    goal: `List the sellers on ${url}`,
    contract: {
      deliverable: 'table',
      requiredFields: ['seller'],
      filters: [],
      requiredSources: ['challenge-interstitial.yantra.test'],
    },
    userLocation: null,
    serps: [],
    script: [
      fetchStep(url, 'challenge'),
      publishStep('Listing sellers', 'Attempted the requested listing; see notices.'),
    ],
    expectations: [...crossCuttingExpectations(), ...expectations],
    tiers: ['deterministic'],
    truth: () => [],
  };
}
