/**
 * `multi-table`: the answer sits in the second table on the page (TODO line
 * 214: an extractor that reads only the first table misses it).
 */

import { equals, type Expectation } from '../expectations.js';
import { MULTI_TABLE_ANSWER, MULTI_TABLE_PATH } from '../fixtures/multi-table.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  arrayOf,
  crossCuttingExpectations,
  fetchStep,
  publishStep,
  resultLabelled,
} from './common.js';

const PAGE_URL = `${originOf('multi-table')}${MULTI_TABLE_PATH}`;

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'answer-in-second-table',
    owner: 'FEAT-051',
    measure: (run) => {
      const tables = arrayOf(resultLabelled(run, 'specifications'), 'tables');
      if (tables === null) return null;
      return tables.findIndex((table) => JSON.stringify(table).includes(MULTI_TABLE_ANSWER.cell));
    },
    target: equals(MULTI_TABLE_ANSWER.tableIndex),
    baseline: equals(null),
    note: 'TODO line 214: `tables[1]` holds the answer cell.',
  },
  {
    id: 'answer-cell-reaches-the-agent',
    owner: 'current',
    measure: (run) =>
      resultLabelled(run, 'specifications')?.modelText.includes(MULTI_TABLE_ANSWER.cell) ?? false,
    target: equals(true),
    note: 'Today the answer cell survives extraction as text; it must stay reachable.',
  },
];

export const multiTable: Scenario = {
  id: 'multi-table',
  sites: ['multi-table'],
  command: 'research',
  goal: `What is the towing capacity of the Norvale Teyra Summit AWD? Use ${PAGE_URL}`,
  contract: {
    deliverable: 'answer',
    requiredFields: ['towing'],
    filters: [],
    requiredSources: ['multi-table.yantra.test'],
  },
  userLocation: null,
  serps: [{ match: 'towing', results: [{ url: PAGE_URL, title: 'Specifications' }] }],
  script: [
    fetchStep(PAGE_URL, 'specifications'),
    publishStep('Norvale Teyra towing capacity', 'Read the specification tables; see sources.'),
  ],
  expectations,
  tiers: ['deterministic', 'agentic'],
  truth: () => [
    {
      itemId: 'towing-summit-awd',
      key: { title: `${MULTI_TABLE_ANSWER.trim} ${MULTI_TABLE_ANSWER.drivetrain}` },
      fields: { towing: MULTI_TABLE_ANSWER.cell },
    },
  ],
};
