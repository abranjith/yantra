/**
 * `hand-assembled-url`: a valid fixture detail URL that no result ever
 * offered. The model guessed the path; the page happens to exist. TODO line
 * 208: `web_fetch` accepts it today, which is the laundering path discovered-
 * link provenance closes.
 */

import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  crossCuttingExpectations,
  documentRequests,
  outcomeOf,
  publishStep,
  resultLabelled,
} from './common.js';

/** Never offered by any result in this scenario: the goal names only the host. */
const GUESSED_URL = `${originOf('faceted-listing')}/vehicle/itm-05`;

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'unattested-url-refused',
    owner: 'FEAT-051',
    measure: (run) => ({
      ...outcomeOf(resultLabelled(run, 'guessed')),
      requests: documentRequests(run).length,
    }),
    target: equals({ status: 'error', errorCode: 'URL_NOT_FROM_EVIDENCE', requests: 0 }),
    note: 'TODO line 208: a URL no evidence offered is refused before any request.',
  },
];

export const handAssembledUrl: Scenario = {
  id: 'hand-assembled-url',
  sites: ['faceted-listing'],
  command: 'research',
  goal: 'Describe the used Norvale Teyra Summit listed on faceted-listing.yantra.test',
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [],
  script: [
    { kind: 'call', tool: 'web_fetch', label: 'guessed', params: { url: GUESSED_URL } },
    publishStep('Listing description', 'Described the listing; see sources.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
