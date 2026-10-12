/**
 * `listing-structured`: a collection that exists only as schema.org JSON-LD.
 * Today's extractor reads the visible shell and nothing else.
 */

import { equals, type Expectation } from '../expectations.js';
import { USER_LOCATION, formatAmount, truthRows } from '../fixtures/inventory.js';
import { originOf } from '../fixtures/sites.js';
import { structuredPageItems } from '../fixtures/structured-listing.js';
import type { Scenario } from '../scenario.js';

import {
  arrayOf,
  crossCuttingExpectations,
  fetchStep,
  fieldOf,
  publishStep,
  resultLabelled,
} from './common.js';

const RESULTS_URL = `${originOf('structured-listing')}/results`;
const PAGE_ONE = structuredPageItems(1);

/** The prices the read's Product/Offer entities carry, sorted; null without `structured`. */
function structuredPrices(run: Parameters<Expectation['measure']>[0]): readonly number[] | null {
  const entities = arrayOf(resultLabelled(run, 'results'), 'structured');
  if (entities === null) return null;
  return entities
    .filter((entity) => (entity as { type?: unknown }).type === 'Product')
    .map((entity) =>
      Number((entity as { props?: Record<string, unknown> }).props?.['offers.price']),
    )
    .filter((price) => Number.isFinite(price))
    .sort((left, right) => left - right);
}

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'product-offers-with-truth-prices',
    owner: 'FEAT-051',
    measure: structuredPrices,
    target: equals(PAGE_ONE.map((entry) => entry.price).sort((left, right) => left - right)),
    note: 'G2: the 6 Product/Offer entities carry the truth prices.',
  },
  {
    id: 'visible-text-carries-no-price',
    owner: 'current',
    measure: (run) => {
      const read = resultLabelled(run, 'results');
      const text = fieldOf(read, 'text') ?? fieldOf(read, 'excerpt');
      if (typeof text !== 'string') return 'no text';
      return PAGE_ONE.filter((entry) => text.includes(formatAmount(entry.price))).length;
    },
    target: equals(0),
    note: 'Fixture invariant: the listing data lives only in JSON-LD, never in visible text.',
  },
];

export const listingStructured: Scenario = {
  id: 'listing-structured',
  sites: ['structured-listing'],
  command: 'research',
  goal: `List each seller and price for the Norvale Teyra listings at ${RESULTS_URL}`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: ['structured-listing.yantra.test'],
    limit: 6,
  },
  userLocation: USER_LOCATION,
  serps: [
    {
      match: /teyra|norvale|structured-listing/i,
      results: [{ url: RESULTS_URL, title: 'Norvale Teyra inventory' }],
    },
  ],
  script: [
    fetchStep(RESULTS_URL, 'results'),
    publishStep('Norvale Teyra listings', 'Read the structured listing; see sources.'),
  ],
  expectations,
  tiers: ['deterministic', 'agentic'],
  truth: () => truthRows().slice(0, PAGE_ONE.length),
};
