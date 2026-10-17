/**
 * `do-contract-missing`: a `do` run publishes before declaring a contract
 * (FEAT-054 D4). `result_publish` refuses with `CONTRACT_REQUIRED` and names
 * `task_contract`; one declaration recovers, and the Brief carries the
 * per-item requirements.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import { resultLabelled } from './common.js';
import {
  CAPTURE_CONTRACT,
  FORM_CONTRACT,
  FORM_GOAL,
  NAVIGATE_STEP,
  contractStep,
  fillAnswersStep,
  formExpectations,
  publishFormStep,
  requirementsOf,
} from './do-form.js';

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'publish-refused-without-contract',
    owner: 'FEAT-054',
    measure: (run) => {
      const first = resultLabelled(run, 'publish before contract');
      return {
        code: first?.errorCode ?? null,
        namesTool: first?.modelText.includes('task_contract'),
      };
    },
    target: equals({ code: 'CONTRACT_REQUIRED', namesTool: true }),
    note: 'D4: a do result cannot be judged without a contract; the refusal names the move.',
  },
  {
    id: 'one-declaration-recovers',
    owner: 'FEAT-054',
    measure: (run) => ({
      outcome: run.outcome.kind,
      publish: resultLabelled(run, 'publish')?.status ?? null,
    }),
    target: equals({ outcome: 'published', publish: 'ok' }),
    note: 'D4: after task_contract, the same publish succeeds.',
  },
  {
    id: 'brief-has-requirements',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run),
    target: satisfies('lists the declared requirements', (value) => value !== null),
    note: 'The recovered Brief is judged item by item.',
  },
];

export const doContractMissing: Scenario = {
  id: 'do-contract-missing',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    NAVIGATE_STEP,
    fillAnswersStep(1, 2),
    publishFormStep(undefined, 'publish before contract'),
    contractStep(CAPTURE_CONTRACT),
    publishFormStep(),
  ],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
