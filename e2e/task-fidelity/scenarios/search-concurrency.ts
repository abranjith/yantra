/**
 * `search-concurrency`: a concurrent pair of searches against a scraped
 * provider that challenges overlapping requests — the G4 pattern, where every
 * failure fell inside a concurrent pair.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  crossCuttingExpectations,
  noticesOf,
  publishStep,
  resultsLabelled,
  runtimeEvents,
  searchStep,
} from './common.js';

/** Failed searches' codes, their `tool_failure` warn lines, and `search_failed` notices. */
export function searchFailureEvidence(run: Parameters<Expectation['measure']>[0]): {
  readonly failedCodes: readonly (string | null)[];
  readonly warnLines: number;
  readonly notices: number;
} {
  const failed = run.toolResults.filter(
    (result) => result.tool === 'web_search' && result.status !== 'ok',
  );
  return {
    failedCodes: failed.map((result) => result.errorCode),
    warnLines: runtimeEvents(run, 'tool_failure').filter((line) => line.tool === 'web_search')
      .length,
    notices: noticesOf(run).filter((notice) => notice.kind === 'search_failed').length,
  };
}

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'searches-serialized',
    owner: 'FEAT-050',
    measure: (run) => run.searchPeakConcurrency,
    target: equals(1),
    note: 'G4: the politeness gate serializes a scraped provider.',
  },
  {
    id: 'no-challenges',
    owner: 'FEAT-050',
    measure: (run) => run.searchCalls.filter((call) => call.outcome === 'challenge').length,
    target: equals(0),
    note: '§11 "concurrency-induced search failures": 0.',
  },
  {
    id: 'challenge-classified-and-disclosed',
    owner: 'FEAT-048',
    measure: searchFailureEvidence,
    // Holds before and after FEAT-050: with no failure there is nothing to
    // classify, and with one it must be typed, logged, and disclosed once.
    target: satisfies(
      'every failed search is SEARCH_BLOCKED, with one tool_failure warn each and one search_failed notice',
      (value) => {
        const evidence = value as ReturnType<typeof searchFailureEvidence>;
        return (
          evidence.failedCodes.every((code) => code === 'SEARCH_BLOCKED') &&
          evidence.warnLines === evidence.failedCodes.length &&
          evidence.notices === (evidence.failedCodes.length > 0 ? 1 : 0)
        );
      },
    ),
    note: 'G4 / §11: a challenged search carries SEARCH_BLOCKED, a warn line, and a notice.',
  },
  {
    id: 'pair-ran',
    owner: 'current',
    measure: (run) => resultsLabelled(run, 'web_search').length,
    target: equals(2),
    note: 'Both searches of the pair reach the provider seam.',
  },
];

export const searchConcurrency: Scenario = {
  id: 'search-concurrency',
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
  faults: [{ kind: 'challenge-on-concurrency' }],
  searchProviderName: 'duckduckgo',
  script: [
    {
      kind: 'parallel',
      steps: [
        searchStep('norvale teyra summit price', 'web_search', 1),
        searchStep('norvale teyra summit dealer', 'web_search', 1),
      ],
    },
    publishStep('Search summary', 'Summarized the search results; see notices.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
