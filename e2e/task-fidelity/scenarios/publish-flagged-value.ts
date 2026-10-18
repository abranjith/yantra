import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import { briefOf, crossCuttingExpectations, fetchStep, recordTable } from './common.js';
const URL = `${originOf('faceted-listing')}/new/results`;
const script: readonly ScriptStep[] = [
  fetchStep(URL, 'results'),
  {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: (ctx) => {
      const table = recordTable(ctx, 'results', 1);
      return table === null
        ? null
        : {
            brief: {
              title: 'Listings',
              overview: '',
              table: { ...table, rows: table.rows.map((row) => [row[0], 987654]) },
            },
          };
    },
  },
];
const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'unsupported-value-kept-and-noticed',
    owner: 'FEAT-053',
    measure: (run) => {
      const brief = briefOf(run);
      const facets = brief?.facets as { comparison?: { rows?: unknown[][] } } | undefined;
      const metadata = brief?.metadata as
        | { citation_verdict?: { flagged?: number; stripped?: number } }
        | undefined;
      return {
        price: facets?.comparison?.rows?.[0]?.[1],
        flagged: metadata?.citation_verdict?.flagged,
        stripped: metadata?.citation_verdict?.stripped,
        pointer: JSON.stringify(brief?.notices).includes('table/rows/0/1'),
      };
    },
    target: equals({ price: 987654, flagged: 1, stripped: 0, pointer: true }),
    note: 'One invented price is flagged at its cell, never removed.',
  },
];
export const publishFlaggedValue: Scenario = {
  id: 'publish-flagged-value',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `Read listings from ${URL}.`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: [],
  },
  userLocation: null,
  serps: [],
  script,
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
