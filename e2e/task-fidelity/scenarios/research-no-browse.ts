/**
 * `research-no-browse`: with browsing turned off (`--no-browse`, or
 * `agent.research_browse: false`) research has no browser tool at all, and
 * its per-run prompt says so (FEAT-052).
 */

import { equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import { crossCuttingExpectations, publishStep, scopeLineOf } from './common.js';

const HOST = 'faceted-listing.yantra.test';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'browser-call-refused-as-unknown',
    owner: 'FEAT-052',
    measure: (run) => run.unreachable,
    target: equals(['browser_navigate (tool not registered)']),
    note: 'G1: with browsing off, a browser tool does not exist for the run.',
  },
  {
    id: 'no-browser-tools',
    owner: 'FEAT-052',
    measure: (run) => run.registeredTools.filter((name) => name.startsWith('browser_')),
    target: equals([]),
    note: 'G1: the no-browse catalog has no browser_* tool.',
  },
  {
    id: 'scope-line-says-no-browser',
    owner: 'FEAT-052',
    measure: (run) => scopeLineOf(run),
    target: equals('Scope: web search and page reading only; this run has no live browser.'),
    note: 'G1: the per-run scope line never claims a browser the run lacks.',
  },
  {
    id: 'no-browser-launched',
    owner: 'current',
    measure: (run) => run.browserLaunches,
    target: equals(0),
    note: 'Nothing in a no-browse run starts a browser for a refused navigation.',
  },
];

export const researchNoBrowse: Scenario = {
  id: 'research-no-browse',
  sites: ['faceted-listing'],
  command: 'research',
  browse: false,
  goal: `List the new listings with seller and price. Use ${HOST}`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: [HOST],
  },
  userLocation: null,
  serps: [],
  script: [
    { kind: 'call', tool: 'browser_navigate', params: { url: `http://${HOST}/` } },
    publishStep('SUV listings', 'No browser was available.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
