/**
 * `do-form-historical`: the run that motivated FEAT-054, replayed as a
 * script. It declares the goal's action terms, fills ten fields of a form
 * larger than the observation cap, runs past the exploration wind-down, and
 * publishes honestly with unmet items.
 *
 * Before FEAT-054 the same run was `completed` and exited 0. Now it is
 * `partial`, keeps its Brief, records `wall-clock-soft`, and exits 2.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import { briefOf } from './common.js';
import {
  FORM_CONTRACT,
  FORM_GOAL,
  FULL_ACTIONS_CONTRACT,
  NAVIGATE_STEP,
  contractStep,
  exitCodeOf,
  fillAnswersStep,
  firstLineOf,
  formExpectations,
  manifestOutcomeOf,
  publishFormStep,
  requirementsOf,
  taskOutcomeOf,
} from './do-form.js';

/** Past the default 12-minute wind-down and short of the 15-minute deadline. */
const PAST_SOFT_BOUNDARY_MS = 12.5 * 60 * 1000;

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'partial-not-completed',
    owner: 'FEAT-054',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'partial', exit: 2 }),
    note: 'Plan G8: a Brief with unmet items is partial and exits 2, never completed and 0.',
  },
  {
    id: 'brief-kept',
    owner: 'FEAT-054',
    measure: (run) => briefOf(run) !== null,
    target: equals(true),
    note: 'D3: partial means a Brief was saved.',
  },
  {
    id: 'manifest-outcome',
    owner: 'FEAT-054',
    measure: (run) => manifestOutcomeOf(run),
    target: equals({
      status: 'failed',
      failureClass: 'budget_exhausted',
      taskOutcome: 'partial',
      terminationReason: 'wall-clock-soft',
    }),
    note: 'D3: the manifest records the outcome and, separately, why the run stopped.',
  },
  {
    id: 'per-item-status',
    owner: 'FEAT-054',
    measure: (run) => {
      const items = requirementsOf(run);
      return items === null
        ? null
        : Object.fromEntries(Object.entries(items).map(([id, item]) => [id, item.status]));
    },
    target: equals({
      deliverable: 'met',
      fill: 'unmet',
      'artifact:screenshot:viewport': 'unmet',
      'effects.submit': 'met',
    }),
    note: 'G4: the screenshot and no-submit live in the contract and are each judged.',
  },
  {
    id: 'first-line-names-the-screenshot',
    owner: 'FEAT-054',
    measure: (run) => firstLineOf(run),
    target: satisfies(
      'starts with "Partial:" and names the missing screenshot',
      (line) =>
        typeof line === 'string' &&
        line.startsWith('Partial:') &&
        line.includes('viewport screenshot not captured'),
    ),
    note: 'G8: the first terminal line says the task was not done, and what is missing.',
  },
  {
    id: 'first-line-counts-the-fields',
    owner: 'FEAT-055',
    measure: (run) => firstLineOf(run),
    target: satisfies(
      'names "fields 10 of" the eligible total',
      (line) => typeof line === 'string' && line.includes('fields 10 of'),
    ),
    baseline: satisfies(
      'says the fields were not counted: no form census yet',
      (line) =>
        typeof line === 'string' && line.includes('fields not counted (inventory_unavailable)'),
    ),
    note: 'G1: counting filled fields needs FEAT-055 TASK-001 census of the whole form.',
  },
];

export const doFormHistorical: Scenario = {
  id: 'do-form-historical',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    fillAnswersStep(1, 10),
    { kind: 'advance-clock', ms: PAST_SOFT_BOUNDARY_MS },
    publishFormStep({
      met: false,
      unmet: [
        { item: 'fill', reason: 'ran out of time after ten fields' },
        { item: 'screenshot', reason: 'no screenshot tool was available' },
      ],
    }),
  ],
  expectations,
  tiers: ['deterministic'],
  // Ten plain fills in real Chrome, each waiting out the suggestion window.
  timeoutMs: 240_000,
  truth: () => [],
};
