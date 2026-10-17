/**
 * `do-revision-drops-screenshot`: a second contract revision omits the
 * screenshot the first one requested (FEAT-054 S2). The item is carried
 * forward and still judged: it stays in the Brief, declared in revision 1,
 * and unmet because nothing was captured.
 */

import { equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_CONTRACT,
  FORM_CONTRACT,
  FORM_GOAL,
  FORM_HOST,
  NAVIGATE_STEP,
  contractStep,
  fillAnswersStep,
  formExpectations,
  publishFormStep,
  requirementsOf,
  taskOutcomeOf,
} from './do-form.js';

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'screenshot-still-judged',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport'] ?? null,
    target: equals({ status: 'unmet', declared_in: 1 }),
    note: 'Plan §8: an item a later revision omits is carried forward and still evaluated.',
  },
  {
    id: 'contract-records-origin',
    owner: 'FEAT-054',
    measure: (run) =>
      (run.artifacts.contract as { requirements?: unknown } | null)?.requirements ?? null,
    target: equals([
      { id: 'artifact:screenshot:viewport', declared_in: 1 },
      { id: 'effects.submit', declared_in: 1 },
    ]),
    note: 'Plan §6: contract.json records the revision that declared each item.',
  },
  {
    id: 'partial',
    owner: 'FEAT-054',
    measure: (run) => taskOutcomeOf(run),
    target: equals('partial'),
    note: 'Dropping an item from the contract cannot drop it from the outcome.',
  },
];

export const doRevisionDropsScreenshot: Scenario = {
  id: 'do-revision-drops-screenshot',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    contractStep(CAPTURE_CONTRACT, 'contract rev1'),
    contractStep(
      {
        deliverable: 'actions',
        subject: 'the membership application form',
        required_sources: [FORM_HOST],
      },
      'contract rev2',
    ),
    NAVIGATE_STEP,
    fillAnswersStep(1, 2),
    publishFormStep(),
  ],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
