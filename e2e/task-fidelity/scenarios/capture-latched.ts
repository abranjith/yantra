/**
 * `capture-latched`: the secret latch (FEAT-058, plan §7). After a stored
 * secret was dispatched on the page, a capture is refused with the same code
 * Vision Assist uses, nothing is written, and no canary reaches any artifact.
 * Once the page navigates to a new document, a capture succeeds again.
 *
 * The harness denies every confirmation and a secret fill always asks, so the
 * fill is stood in for by the `latch-sensitive-screen` step, which sets the
 * latch exactly where the fill would.
 */

import { equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_URL,
  captureContract,
  captureGoal,
  captureStep,
  declareStep,
  fillNameStep,
  onDiskCaptures,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations, resultLabelled } from './common.js';
import { requirementsOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'latched-capture-refused',
    owner: 'FEAT-058',
    measure: (run) => {
      const result = resultLabelled(run, 'capture latched');
      return { status: result?.status ?? null, code: result?.errorCode ?? null };
    },
    target: equals({ status: 'error', code: 'SCREENSHOT_SENSITIVE_SCREEN' }),
    note: 'Plan §7: a latched secret screen is refused with the code Vision Assist uses.',
  },
  {
    id: 'capture-after-new-document',
    owner: 'FEAT-058',
    measure: (run) => resultLabelled(run, 'capture')?.status ?? null,
    target: equals('ok'),
    note: 'The latch clears on a new top-level document; capture resumes.',
  },
  {
    id: 'only-the-later-capture-on-disk',
    owner: 'FEAT-058',
    measure: (run) => onDiskCaptures(run),
    target: equals({ files: 1, matching: 1 }),
    note: 'The refused capture wrote nothing; the later one is the only file.',
  },
  {
    id: 'met-after-refill',
    owner: 'FEAT-058',
    measure: (run) => ({
      outcome: taskOutcomeOf(run),
      item: requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    }),
    target: equals({ outcome: 'fulfilled', item: 'met' }),
    note: 'A capture after the last action on the new document meets the item.',
  },
];

export const captureLatched: Scenario = {
  id: 'capture-latched',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_URL, 'what is visible'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    declareStep(captureContract('viewport')),
    openStep(TALL_URL),
    fillNameStep(),
    { kind: 'latch-sensitive-screen' },
    captureStep('viewport', 'capture latched'),
    openStep(TALL_URL, 'reopen page'),
    fillNameStep('fill name again'),
    captureStep('viewport'),
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
