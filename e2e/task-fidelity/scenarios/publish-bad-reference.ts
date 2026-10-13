import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, matchesShape, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  briefOf,
  crossCuttingExpectations,
  fetchStep,
  recordTable,
  resultLabelled,
  toolCallPhases,
} from './common.js';
const URL = `${originOf('faceted-listing')}/new/results`;
const publish = (bad: boolean): ScriptStep => ({
  kind: 'call',
  tool: 'result_publish',
  label: bad ? 'invalid' : 'corrected',
  params: (ctx) => {
    const table = recordTable(ctx, 'results', 1);
    return table === null
      ? null
      : {
          brief: {
            title: 'Listings',
            overview: '',
            table: bad ? { ...table, row_sources: [['S9']] } : table,
          },
        };
  },
});
const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'fresh-manifest-agent-v10',
    owner: 'FEAT-053',
    measure: (run) =>
      (run.artifacts.manifest as { agent?: { prompt_version?: string } } | null)?.agent
        ?.prompt_version,
    target: equals('agent-v10'),
    note: 'The real run recorder stamps the current publish-guidance version.',
  },
  {
    id: 'unknown-source-is-correctable',
    owner: 'FEAT-053',
    measure: (run) => {
      const call = resultLabelled(run, 'invalid');
      return { code: call?.errorCode, details: call?.details };
    },
    target: matchesShape({
      code: 'BRIEF_INVALID',
      details: { issues: [{ cause: 'reference-unknown', pointer: 'table/row_sources/0/0' }] },
    }),
    note: 'An invented source is rejected with a pointer and cause.',
  },
  {
    id: 'corrected-row-resolves',
    owner: 'FEAT-053',
    measure: (run) => briefOf(run)?.facets,
    target: matchesShape({ comparison: { row_citations: [[1]] } }),
    note: 'The corrected reference comes from the record result, never a typed ID.',
  },
  {
    id: 'both-calls-audited',
    owner: 'FEAT-053',
    measure: (run) => toolCallPhases(run, 'result_publish'),
    target: equals(['start', 'end', 'start', 'end']),
    note: 'Both the refusal and correction are durable.',
  },
  {
    id: 'one-count-only-composition-log',
    owner: 'FEAT-053',
    measure: (run) =>
      run.artifacts.runtime?.lines.filter(
        (line) => (line as { event?: string }).event === 'brief_composed',
      ).length,
    target: equals(1),
    note: 'Only successful composition is logged.',
  },
];
export const publishBadReference: Scenario = {
  id: 'publish-bad-reference',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `Read listings at ${URL}.`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [],
    requiredSources: [],
  },
  userLocation: null,
  serps: [],
  script: [fetchStep(URL, 'results'), publish(true), publish(false)],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
