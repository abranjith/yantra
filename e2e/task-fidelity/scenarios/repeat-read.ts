/**
 * `repeat-read`: the same page read three times — G5, where one results page
 * was fetched seven times in a run.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  crossCuttingExpectations,
  fetchStep,
  fieldOf,
  healthOf,
  publishStep,
  requestsFor,
  resultsLabelled,
} from './common.js';

const RESULTS_URL = `${originOf('faceted-listing')}/new/results`;

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'one-network-read',
    owner: 'FEAT-050',
    measure: (run) => requestsFor(run, RESULTS_URL),
    target: equals(1),
    baseline: equals(3),
    note: 'G5 / §11 "navigations spent re-reading a page": 0.',
  },
  {
    id: 'repeats-answer-already-read',
    owner: 'FEAT-050',
    measure: (run) =>
      resultsLabelled(run, 'results')
        .slice(1)
        .map((result) => fieldOf(result, 'already_read')),
    target: equals(['S1', 'S1']),
    baseline: equals([null, null]),
    note: 'G5: a repeat read returns `{already_read: "S1"}` without fetching.',
  },
  {
    id: 'health-counts-the-server-repeats',
    owner: 'FEAT-048',
    measure: (run) => ({
      reported: (healthOf(run)?.fetches as { repeat_fetches?: unknown } | undefined)
        ?.repeat_fetches,
      served: Math.max(0, requestsFor(run, RESULTS_URL) - 1),
    }),
    target: satisfies('run-health repeat_fetches equals the server-counted repeats', (value) => {
      const { reported, served } = value as { reported: unknown; served: number };
      return reported === served;
    }),
    note: 'FEAT-048: the run’s own repeat count agrees with an independent witness.',
  },
];

export const repeatRead: Scenario = {
  id: 'repeat-read',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `Summarize the listings at ${RESULTS_URL}`,
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [],
  script: [
    fetchStep(RESULTS_URL, 'results'),
    fetchStep(RESULTS_URL, 'results'),
    fetchStep(RESULTS_URL, 'results'),
    publishStep('Listing summary', 'Read the listing; see sources.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
