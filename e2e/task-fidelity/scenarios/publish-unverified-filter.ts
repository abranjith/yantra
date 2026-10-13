import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, matchesShape, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';
import { scoreRun } from '../score/scorer.js';

import { briefOf, crossCuttingExpectations, fetchStep, recordTable } from './common.js';
const HOST = 'faceted-listing.yantra.test';
const URL = `${originOf('faceted-listing')}/new/results`;
const script: readonly ScriptStep[] = [
  {
    kind: 'call',
    tool: 'task_contract',
    params: {
      deliverable: 'table',
      subject: 'listings',
      required_fields: ['seller', 'price'],
      required_sources: [HOST],
      filters: [{ name: 'drivetrain', value: 'AWD' }],
    },
  },
  fetchStep(URL, 'results'),
  {
    kind: 'call',
    tool: 'result_publish',
    label: 'publish',
    params: (ctx) => {
      const table = recordTable(ctx, 'results', 1);
      return table === null ? null : { brief: { title: 'Listings', overview: '', table } };
    },
  },
];
const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'unreported-filter-remains-unknown',
    owner: 'FEAT-053',
    measure: (run) => briefOf(run)?.constraints,
    target: matchesShape([
      { name: 'drivetrain', value: 'AWD', status: 'unverified', citations: [] },
    ]),
    note: 'No unconfirmed filter is asserted as verified.',
  },
  {
    id: 'cause-and-conditions-visible',
    owner: 'FEAT-053',
    measure: (run) =>
      readFileSync(join(run.runDir, 'brief.md'), 'utf8').includes(
        '**Conditions:** drivetrain = AWD — unverified',
      ) && JSON.stringify(briefOf(run)?.notices).includes('not reported by the agent'),
    target: equals(true),
    note: 'The condition and cause reach the portable document.',
  },
  {
    id: 'no-unverified-assertion',
    owner: 'FEAT-053',
    measure: (run) => scoreRun(run, run.scenario, []).constraint_fidelity.detail.length,
    target: equals(0),
    note: 'The scorer reports no asserted-unverified violation.',
  },
];
export const publishUnverifiedFilter: Scenario = {
  id: 'publish-unverified-filter',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `Read AWD listings from ${URL}.`,
  contract: {
    deliverable: 'table',
    requiredFields: ['seller', 'price'],
    filters: [{ name: 'drivetrain', value: 'AWD' }],
    requiredSources: [HOST],
  },
  userLocation: null,
  serps: [],
  script,
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
