/**
 * `search-empty-timeout`: two different provider failures must read as two
 * different causes (memory → Coding Standards: "two failures sharing an error
 * code must not read identically", and conversely here, two causes never share
 * one code).
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  crossCuttingExpectations,
  noticesOf,
  publishStep,
  resultsLabelled,
  searchStep,
} from './common.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'typed-causes',
    owner: 'FEAT-048',
    measure: (run) => resultsLabelled(run, 'web_search').map((result) => result.errorCode),
    target: equals(['SEARCH_NO_RESULTS', 'SEARCH_TIMEOUT']),
    note: 'G4: empty results and a timeout carry their own stable codes.',
  },
  {
    id: 'distinct-model-text',
    owner: 'FEAT-048',
    measure: (run) => resultsLabelled(run, 'web_search').map((result) => result.modelText),
    target: satisfies(
      'two failures with different model text',
      (value) => Array.isArray(value) && value.length === 2 && value[0] !== value[1],
    ),
    note: 'Memory → Coding Standards: two causes never read identically.',
  },
  {
    id: 'one-notice-per-cause',
    owner: 'FEAT-048',
    measure: (run) => noticesOf(run).filter((notice) => notice.kind === 'search_failed').length,
    target: equals(2),
    note: '§11 "run faults disclosed in Brief notices": one search_failed notice per code.',
  },
];

export const searchEmptyTimeout: Scenario = {
  id: 'search-empty-timeout',
  sites: [],
  command: 'research',
  goal: 'Find Norvale Teyra listings and summarize what the search found.',
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [],
  faults: [
    { kind: 'empty', onCall: [1] },
    { kind: 'timeout', onCall: [2] },
  ],
  searchProviderName: 'duckduckgo',
  script: [
    searchStep('norvale teyra summit', 'web_search', 1),
    searchStep('norvale teyra summit dealer', 'web_search', 1),
    publishStep('Search summary', 'Both searches failed; see notices.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
