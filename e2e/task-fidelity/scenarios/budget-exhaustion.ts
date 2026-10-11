/**
 * `budget-exhaustion`: the run's own navigation budget runs out inside a
 * search. That is Yantra's limit, not the site's refusal (G6): no `blocked`
 * stage, no rank penalty, and a notice that names the budget.
 */

import { equals, type Expectation } from '../expectations.js';
import { ARTICLE_PATH } from '../fixtures/article.js';
import { MULTI_TABLE_PATH } from '../fixtures/multi-table.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  arrayOf,
  crossCuttingExpectations,
  fieldOf,
  noticesOf,
  publishStep,
  resultLabelled,
  searchStep,
} from './common.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'budget-reported-once-at-top-level',
    owner: 'FEAT-048',
    measure: (run) =>
      (fieldOf(resultLabelled(run, 'web_search'), 'budget') as { exhausted?: unknown } | null)
        ?.exhausted ?? null,
    target: equals('navigations'),
    note: 'G6: the search reports the exhausted navigation budget once, at the top level.',
  },
  {
    id: 'no-blocked-stage',
    owner: 'FEAT-048',
    measure: (run) =>
      (arrayOf(resultLabelled(run, 'web_search'), 'failures') ?? []).map(
        (failure) => (failure as { stage?: unknown }).stage ?? null,
      ),
    target: equals([]),
    note: 'G6: a budget refusal is never a per-site `blocked` failure.',
  },
  {
    id: 'no-blocked-rank-signal',
    owner: 'FEAT-048',
    measure: (run) => run.rankSignals.filter((signal) => signal.reason === 'blocked').length,
    target: equals(0),
    note: '§11 "domains rank-penalized for our own budget": 0.',
  },
  {
    id: 'budget-notice-names-yantra',
    owner: 'FEAT-048',
    measure: (run) =>
      noticesOf(run).filter(
        (notice) => notice.kind === 'budget_exhausted' && notice.source === 'runtime',
      ).length,
    target: equals(1),
    note: 'G6: one budget_exhausted notice attributes the limit to Yantra.',
  },
];

export const budgetExhaustion: Scenario = {
  id: 'budget-exhaustion',
  sites: ['faceted-listing', 'structured-listing', 'article', 'multi-table'],
  command: 'research',
  goal: 'Find Norvale Teyra listings and summarize what the search found.',
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [
    {
      match: 'teyra',
      results: [
        { url: `${originOf('faceted-listing')}/new/results`, title: 'Listing' },
        { url: `${originOf('structured-listing')}/results`, title: 'Inventory' },
        { url: `${originOf('multi-table')}${MULTI_TABLE_PATH}`, title: 'Specifications' },
        { url: `${originOf('article')}${ARTICLE_PATH}`, title: 'Guide' },
      ],
    },
  ],
  budgets: { maxNavigations: 2 },
  script: [
    searchStep('norvale teyra summit', 'web_search', 3),
    publishStep('Search summary', 'Summarized the readable results; see notices.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
