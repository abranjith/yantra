/**
 * `contract-invalid`: a table contract with no fields is refused with its own
 * cause, nothing is persisted, and the run still discloses the missing
 * contract (FEAT-052).
 */

import { equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  contractNoticesOf,
  contractOf,
  crossCuttingExpectations,
  publishStep,
  resultLabelled,
  runtimeEvents,
} from './common.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'refused-with-cause',
    owner: 'FEAT-052',
    measure: (run) => ({
      code: resultLabelled(run, 'contract')?.errorCode ?? null,
      causes: runtimeEvents(run, 'tool_failure')
        .filter((line) => line.tool === 'task_contract')
        .map((line) => line.cause),
    }),
    target: equals({ code: 'INVALID_INPUT', causes: ['contract-table-fields'] }),
    note: 'G9: an invalid contract fails with a cause-specific INVALID_INPUT.',
  },
  {
    id: 'no-contract-file',
    owner: 'FEAT-052',
    measure: (run) => contractOf(run),
    target: equals(null),
    note: 'A refused declaration writes nothing.',
  },
  {
    id: 'missing-contract-notice',
    owner: 'FEAT-052',
    measure: (run) => contractNoticesOf(run),
    target: equals([{ kind: 'other', source: 'task-contract' }]),
    note: 'G9: a run whose only declaration failed still discloses the missing contract.',
  },
  {
    id: 'published',
    owner: 'current',
    measure: (run) => run.outcome.kind,
    target: equals('published'),
    note: 'A failed contract call never blocks publishing.',
  },
];

export const contractInvalid: Scenario = {
  id: 'contract-invalid',
  sites: ['faceted-listing'],
  command: 'research',
  goal: 'List new SUV listings with seller and price',
  contract: { deliverable: 'table', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [],
  script: [
    {
      kind: 'call',
      tool: 'task_contract',
      label: 'contract',
      params: { deliverable: 'table', subject: 'new SUV listings' },
    },
    publishStep('SUV listings', 'No listing was read.'),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
