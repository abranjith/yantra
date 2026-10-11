/**
 * `listing-client-rendered`: a collection injected by script after load. The
 * hybrid fetcher escalates the empty shell to a browser render.
 */

import { atMost, equals, type Expectation } from '../expectations.js';
import { INVENTORY, USER_LOCATION, truthRows } from '../fixtures/inventory.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  arrayOf,
  crossCuttingExpectations,
  documentRequests,
  fetchStep,
  publishStep,
  resultLabelled,
} from './common.js';

const RESULTS_URL = `${originOf('client-rendered-listing')}/results`;
const PAGE_ONE_SELLERS = INVENTORY.slice(0, 6).map((entry) => entry.seller);

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'one-browser-launch',
    // Already true today: one escalation, one launch. FEAT-050's shared
    // browser must keep it there while it adds the page pool.
    owner: 'current',
    measure: (run) => run.browserLaunches,
    target: atMost(1),
    note: 'G5 / §11 "Chrome processes per run": a rendered read costs at most one launch.',
  },
  {
    id: 'rendered-read-carries-every-seller',
    owner: 'current',
    measure: (run) => {
      const read = resultLabelled(run, 'results');
      return PAGE_ONE_SELLERS.filter((seller) => read?.modelText.includes(seller) !== true);
    },
    target: equals([]),
    note: 'The browser render reaches the injected cards: all 6 sellers are in the read.',
  },
  {
    id: 'records-carry-every-seller',
    owner: 'FEAT-051',
    measure: (run) => {
      const records = arrayOf(resultLabelled(run, 'results'), 'records');
      if (records === null) return null;
      const text = JSON.stringify(records);
      return PAGE_ONE_SELLERS.filter((seller) => text.includes(seller)).length;
    },
    target: equals(6),
    baseline: equals(null),
    note: 'G2: the rendered collection yields records holding all 6 sellers.',
  },
  {
    id: 'shell-then-render',
    owner: 'current',
    measure: (run) => documentRequests(run).map((entry) => entry.userAgentClass),
    target: equals(['http', 'browser']),
    note: 'G10 escalation path: one HTTP read of the shell, then one browser render.',
  },
];

export const listingClientRendered: Scenario = {
  id: 'listing-client-rendered',
  sites: ['client-rendered-listing'],
  command: 'research',
  goal: `List each seller and price for the Norvale Teyra listings at ${RESULTS_URL}`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: ['client-rendered-listing.yantra.test'],
    limit: 6,
  },
  userLocation: USER_LOCATION,
  serps: [{ match: 'teyra', results: [{ url: RESULTS_URL, title: 'Norvale Teyra listings' }] }],
  script: [
    fetchStep(RESULTS_URL, 'results'),
    publishStep('Norvale Teyra listings', 'Read the rendered listing; see sources.'),
  ],
  expectations,
  tiers: ['deterministic', 'agentic'],
  truth: () => truthRows().slice(0, 6),
};
