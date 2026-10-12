/**
 * `search-breaker`: a scraped provider challenges once; the run must stop
 * asking it (memory → General: "a scraped search provider that challenges
 * once is not queried again in that run").
 */

import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import { crossCuttingExpectations, publishStep, resultsLabelled, searchStep } from './common.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'breaker-trips-after-one-challenge',
    owner: 'FEAT-050',
    measure: (run) => ({
      laterCodes: resultsLabelled(run, 'web_search')
        .slice(1)
        .map((result) => result.errorCode),
      providerCalls: run.searchCalls.length,
    }),
    target: equals({ laterCodes: ['SEARCH_BLOCKED', 'SEARCH_BLOCKED'], providerCalls: 1 }),
    note: 'G4 / §11: a challenge trips the breaker; later searches return SEARCH_BLOCKED unasked.',
  },
  {
    id: 'first-challenge-classified',
    owner: 'FEAT-048',
    measure: (run) => resultsLabelled(run, 'web_search')[0]?.errorCode ?? null,
    target: equals('SEARCH_BLOCKED'),
    note: 'G4: the provider challenge is typed SEARCH_BLOCKED, not "temporarily unavailable".',
  },
  {
    id: 'no-browser-launch',
    owner: 'current',
    measure: (run) => run.browserLaunches,
    target: equals(0),
    note: 'G5: a tripped search launches no browser.',
  },
];

export const searchBreaker: Scenario = {
  id: 'search-breaker',
  sites: ['faceted-listing'],
  command: 'research',
  goal: 'Find Norvale Teyra listings and summarize what the search found.',
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [
    {
      match: 'teyra',
      results: [{ url: `${originOf('faceted-listing')}/new/results`, title: 'Listing' }],
    },
  ],
  faults: [{ kind: 'challenge', onCall: [1] }],
  searchProviderName: 'duckduckgo',
  script: [
    searchStep('norvale teyra summit', 'web_search', 1),
    searchStep('norvale teyra summit price', 'web_search', 1),
    searchStep('norvale teyra summit dealer', 'web_search', 1),
    publishStep('Search summary', 'Summarized the search results; see notices.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
