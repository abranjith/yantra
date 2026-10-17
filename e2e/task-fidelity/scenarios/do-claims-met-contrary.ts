/**
 * `do-claims-met-contrary`: the model publishes `fulfillment.met: true` while
 * the requested screenshot was never captured (FEAT-054). Evidence decides:
 * the run is `partial`, and the Brief carries one notice saying the claim and
 * the evidence disagree.
 */

import { count, equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import { noticesOf } from './common.js';
import {
  CAPTURE_CONTRACT,
  FORM_CONTRACT,
  FORM_GOAL,
  NAVIGATE_STEP,
  contractStep,
  exitCodeOf,
  fillAnswersStep,
  formExpectations,
  publishFormStep,
  requirementsOf,
  taskOutcomeOf,
} from './do-form.js';

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'claim-does-not-decide',
    owner: 'FEAT-054',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'partial', exit: 2 }),
    note: 'Plan §8: a model-authored boolean cannot turn missing evidence into success.',
  },
  {
    id: 'one-disagreement-notice',
    owner: 'FEAT-054',
    measure: (run) => noticesOf(run).filter((notice) => notice.source === 'fulfillment'),
    target: count(1),
    note: 'Plan §8: the disagreement between claim and evidence is disclosed in the Brief.',
  },
  {
    id: 'screenshot-unmet',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    target: equals('unmet'),
    note: 'G4: the requested screenshot is judged from captures, not from the claim.',
  },
];

export const doClaimsMetContrary: Scenario = {
  id: 'do-claims-met-contrary',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    contractStep(CAPTURE_CONTRACT),
    NAVIGATE_STEP,
    fillAnswersStep(1, 2),
    publishFormStep({ met: true, unmet: [] }),
  ],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
