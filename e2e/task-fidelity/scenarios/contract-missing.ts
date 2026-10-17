/**
 * `contract-missing`: a research run that never declares a task contract says
 * so in its Brief (FEAT-052).
 */

import { exitCodeForAgenticOutcome } from '@yantra/agent';

import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import type { Scenario } from '../scenario.js';

import {
  contractNoticesOf,
  contractOf,
  crossCuttingExpectations,
  fetchStep,
  publishStep,
} from './common.js';

const RESULTS_URL = `${originOf('faceted-listing')}/new/results`;

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'one-missing-contract-notice',
    owner: 'FEAT-052',
    measure: (run) => contractNoticesOf(run),
    target: equals([{ kind: 'other', source: 'task-contract' }]),
    note: 'G9: an undeclared research run discloses that nothing was recorded.',
  },
  {
    id: 'no-contract-file',
    owner: 'FEAT-052',
    measure: (run) => contractOf(run),
    target: equals(null),
    note: 'contract.json exists only when a contract was declared.',
  },
  {
    id: 'published',
    owner: 'current',
    measure: (run) => run.outcome.kind,
    target: equals('published'),
    note: 'Declaring a contract is not a precondition for publishing.',
  },
  {
    id: 'research-still-fulfilled-exit-0',
    owner: 'FEAT-054',
    measure: (run) => ({
      outcome: run.outcome.kind === 'published' ? run.outcome.taskOutcome : run.outcome.kind,
      exit: exitCodeForAgenticOutcome(run.outcome),
    }),
    target: equals({ outcome: 'fulfilled', exit: 0 }),
    note: 'D3 compatibility: research keeps its criteria; only the outcome word is new.',
  },
];

export const contractMissing: Scenario = {
  id: 'contract-missing',
  sites: ['faceted-listing'],
  command: 'research',
  goal: `Summarize the listings at ${RESULTS_URL}`,
  contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
  userLocation: null,
  serps: [],
  script: [fetchStep(RESULTS_URL, 'results'), publishStep('Listing summary', 'See sources.')],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
