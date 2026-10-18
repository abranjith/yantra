/**
 * `capture-element-below-fold`: an element capture of a panel at y = 6,000,
 * far outside the viewport (FEAT-058 S5). The element is captured beyond the
 * viewport without scrolling, labeled `beyond_viewport`, and meets the item.
 */

import { equals, type Expectation } from '../expectations.js';
import { TALL_PAGE_PANEL } from '../fixtures/tall-page.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_PANEL_STEP,
  CAPTURE_SCENARIO_CONTRACT,
  OBSERVE_STEP,
  TALL_URL,
  captureContract,
  captureGoal,
  captureModelOf,
  declareStep,
  fillNameStep,
  onDiskCaptures,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations } from './common.js';
import { requirementsOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'panel-captured-beyond-viewport',
    owner: 'FEAT-058',
    measure: (run) => {
      const model = captureModelOf(run) as {
        scope?: unknown;
        complete?: unknown;
        labels?: unknown;
        parts?: { width?: unknown; height?: unknown }[];
      } | null;
      return {
        scope: model?.scope ?? null,
        complete: model?.complete ?? null,
        labels: model?.labels ?? null,
        size: model?.parts?.map((part) => [part.width, part.height]) ?? null,
      };
    },
    target: equals({
      scope: 'element',
      complete: true,
      labels: ['beyond_viewport'],
      size: [[TALL_PAGE_PANEL.width, TALL_PAGE_PANEL.height]],
    }),
    note: 'S5: an element below the fold is captured without scrolling and labeled.',
  },
  {
    id: 'element-met',
    owner: 'FEAT-058',
    measure: (run) => ({
      outcome: taskOutcomeOf(run),
      item: requirementsOf(run)?.['artifact:screenshot:element']?.status ?? null,
    }),
    target: equals({ outcome: 'fulfilled', item: 'met' }),
    note: 'Plan §12: an out-of-viewport target yields a labeled element artifact.',
  },
  {
    id: 'one-file-on-disk',
    owner: 'FEAT-058',
    measure: (run) => onDiskCaptures(run),
    target: equals({ files: 1, matching: 1 }),
    note: 'The element capture is saved and audited.',
  },
];

export const captureElementBelowFold: Scenario = {
  id: 'capture-element-below-fold',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_URL, 'the feature panel'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    declareStep(captureContract('element')),
    openStep(TALL_URL),
    fillNameStep(),
    OBSERVE_STEP,
    CAPTURE_PANEL_STEP,
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
