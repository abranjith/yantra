/**
 * `do-fulfillment-omitted`: the model publishes with no `fulfillment` at all
 * (FEAT-054). The outcome is still computed from evidence: `partial`, with
 * per-item requirements in the Brief and no disagreement notice.
 */

import { equals, type Expectation } from '../expectations.js';
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
    id: 'computed-partial',
    owner: 'FEAT-054',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'partial', exit: 2 }),
    note: 'Plan §8: an omitted claim still yields an outcome judged from evidence.',
  },
  {
    id: 'requirements-present',
    owner: 'FEAT-054',
    measure: (run) => Object.keys(requirementsOf(run) ?? {}),
    target: equals(['deliverable', 'artifact:screenshot:viewport', 'effects.submit']),
    note: 'G4: each declared item is in the Brief with its own status.',
  },
  {
    id: 'no-disagreement-notice',
    owner: 'FEAT-054',
    measure: (run) => noticesOf(run).filter((notice) => notice.source === 'fulfillment'),
    target: equals([]),
    note: 'A claim that was never made cannot disagree with the evidence.',
  },
];

export const doFulfillmentOmitted: Scenario = {
  id: 'do-fulfillment-omitted',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [contractStep(CAPTURE_CONTRACT), NAVIGATE_STEP, fillAnswersStep(1, 2), publishFormStep()],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
