/**
 * `listing-table+faults` (agentic tier): the motivating task under the
 * motivating fault mix — a scraped provider that challenges every concurrent
 * request (run `20260925T130634Z` lost 11 of 22 searches that way), with the
 * production navigation budget of 30.
 */

import type { Scenario } from '../scenario.js';

import { listingTable } from './listing-table.js';

export const listingTableFaults: Scenario = {
  ...listingTable,
  id: 'listing-table+faults',
  faults: [{ kind: 'challenge-on-concurrency' }],
  searchProviderName: 'duckduckgo',
  budgets: { maxNavigations: 30 },
  expectations: [],
  tiers: ['agentic'],
};
