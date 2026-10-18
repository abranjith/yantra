/**
 * `capture-full-page-truncated`: a full-page capture of a 30,000 px page
 * (FEAT-058 S5/S6). The capture stops after six 4,096 px tiles and labels the
 * set `truncated`; an incomplete set does not meet the full-page item, so the
 * run is honestly `partial` with reason `capture_incomplete`.
 */

import { equals, type Expectation } from '../expectations.js';
import { TALL_PAGE_LONG_HEIGHT } from '../fixtures/tall-page.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_LONG_URL,
  captureContract,
  captureGoal,
  captureModelOf,
  captureStep,
  declareStep,
  fillNameStep,
  onDiskCaptures,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations } from './common.js';
import { exitCodeOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'six-truncated-tiles',
    owner: 'FEAT-058',
    measure: (run) => {
      const model = captureModelOf(run) as {
        complete?: unknown;
        labels?: unknown;
        parts?: unknown[];
        captured_height?: unknown;
        page_height?: unknown;
      } | null;
      return {
        complete: model?.complete ?? null,
        labels: model?.labels ?? null,
        parts: model?.parts?.length ?? null,
        captured: model?.captured_height ?? null,
        page: model?.page_height ?? null,
      };
    },
    target: equals({
      complete: false,
      labels: ['truncated'],
      parts: 6,
      captured: 6 * 4096,
      page: TALL_PAGE_LONG_HEIGHT,
    }),
    note: 'S5: a page taller than six tiles is cut and says so; the result never claims more.',
  },
  {
    id: 'incomplete-is-partial',
    owner: 'FEAT-058',
    measure: (run) => ({
      outcome: taskOutcomeOf(run),
      exit: exitCodeOf(run),
      reason:
        run.outcome.kind === 'published'
          ? (run.outcome.requirements?.unmet.find(
              (item) => item.id === 'artifact:screenshot:full_page',
            )?.reason ?? null)
          : null,
    }),
    target: equals({ outcome: 'partial', exit: 2, reason: 'capture_incomplete' }),
    note: 'S6: a truncated page is not the page the user asked for.',
  },
  {
    id: 'six-files-on-disk',
    owner: 'FEAT-058',
    measure: (run) => onDiskCaptures(run),
    target: equals({ files: 6, matching: 6 }),
    note: 'Every tile that was captured is saved and audited.',
  },
];

export const captureFullPageTruncated: Scenario = {
  id: 'capture-full-page-truncated',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_LONG_URL, 'the whole page'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    declareStep(captureContract('full_page')),
    openStep(TALL_LONG_URL),
    fillNameStep(),
    captureStep('full_page'),
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
