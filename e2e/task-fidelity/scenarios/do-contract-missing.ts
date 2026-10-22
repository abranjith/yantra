/**
 * `do-contract-missing`: a `do` run acts and publishes before declaring a
 * contract. The fill is refused with `CONTRACT_REQUIRED` before it touches the
 * page (REV-003: the contract's effects bind the first action), and so is
 * `result_publish` (FEAT-054 D4); both name `task_contract`. One declaration
 * recovers both, and the Brief carries the per-item requirements.
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
    id: 'fill-refused-without-contract',
    owner: 'FEAT-054',
    measure: (run) => {
      const first = resultLabelled(run, 'fill before contract');
      return {
        code: first?.errorCode ?? null,
        namesTool: first?.modelText.includes('task_contract'),
      };
    },
    target: equals({ code: 'CONTRACT_REQUIRED', namesTool: true }),
    note: 'A page change waits for the contract, so effects.submit binds the first action.',
  },
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
    fillAnswersStep(1, 2, 'fill before contract'),
    publishFormStep(undefined, 'publish before contract'),
    contractStep(CAPTURE_CONTRACT),
    fillAnswersStep(1, 2),
    publishFormStep(),
  ],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
