import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, matchesShape, type Expectation } from '../expectations.js';
import { ARTICLE_PATH } from '../fixtures/article.js';
import { truthRows } from '../fixtures/inventory.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';
import { scoreRun } from '../score/scorer.js';

import { briefOf, crossCuttingExpectations, fetchStep, recordTable, sourceIdOf } from './common.js';

const HOST = 'faceted-listing.yantra.test';
const URL = `${originOf('faceted-listing')}/new/results`;
const ARTICLE = `${originOf('article')}${ARTICLE_PATH}`;
const script: readonly ScriptStep[] = [
  {
    kind: 'call',
    tool: 'task_contract',
    params: {
      deliverable: 'table',
      subject: 'listings',
      required_fields: ['seller', 'price'],
      required_sources: [HOST],
    },
  },
  fetchStep(URL, 'results'),
  fetchStep(ARTICLE, 'article'),
  {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: (ctx) => {
      const table = recordTable(ctx);
      const source = sourceIdOf(ctx.labelled('article')[0]);
      return table === null || source === null
        ? null
        : {
            brief: {
              title: 'Listings and alternatives',
              overview: '',
              table: {
                ...table,
                rows: [...table.rows, ['Article alternative', 1]],
                row_sources: [...table.row_sources, [source]],
              },
            },
          };
    },
  },
];
const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'main-table-three-rows',
    owner: 'FEAT-053',
    measure: (run) => briefOf(run)?.facets,
    target: matchesShape({ comparison: { row_citations: [[2], [2], [2]] } }),
    note: 'G7: three on-contract rows stay in the comparison.',
  },
  {
    id: 'alternatives-labelled-and-noticed',
    owner: 'FEAT-053',
    measure: (run) => {
      const brief = briefOf(run);
      const sections = brief?.sections as { kind?: string }[] | undefined;
      const notices = brief?.notices as { reason?: string }[] | undefined;
      return {
        sections: sections?.filter((section) => section.kind === 'alternatives').length,
        notice: notices?.some((notice) => notice.reason?.includes('1 rows and 0 findings')),
      };
    },
    target: equals({ sections: 1, notice: true }),
    note: 'G7: off-contract content has a machine-readable alternatives label and notice.',
  },
  {
    id: 'source-fidelity-excludes-alternatives',
    owner: 'FEAT-053',
    measure: (run) => scoreRun(run, run.scenario, truthRows()).source_fidelity.value,
    target: equals(1),
    note: 'Alternatives never dilute main-answer source fidelity.',
  },
];
export const publishAlternatives: Scenario = {
  id: 'publish-alternatives',
  sites: ['faceted-listing', 'article'],
  command: 'research',
  goal: `Read listings from ${URL} and alternatives from ${ARTICLE}.`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: [HOST],
  },
  userLocation: null,
  serps: [],
  script,
  expectations,
  tiers: ['deterministic'],
  truth: () => truthRows(),
};
