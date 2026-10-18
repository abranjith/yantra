/**
 * `capture-full-page-tall`: a full-page capture of a page about 9,000 px tall
 * (FEAT-058 S5). The page is split into three tiles of at most 4,096 px, the
 * set is complete, and the full-page item is met.
 */

import { equals, type Expectation } from '../expectations.js';
import { TALL_PAGE_HEIGHT } from '../fixtures/tall-page.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_URL,
  briefArtifactsOf,
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
import { requirementsOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'three-complete-tiles',
    owner: 'FEAT-058',
    measure: (run) => {
      const model = captureModelOf(run) as {
        complete?: unknown;
        labels?: unknown;
        parts?: { height?: unknown }[];
        captured_height?: unknown;
      } | null;
      return {
        complete: model?.complete ?? null,
        labels: model?.labels ?? null,
        heights: model?.parts?.map((part) => part.height) ?? null,
        captured: model?.captured_height ?? null,
      };
    },
    target: equals({
      complete: true,
      labels: [],
      heights: [4096, 4096, TALL_PAGE_HEIGHT - 8192],
      captured: TALL_PAGE_HEIGHT,
    }),
    note: 'S5: a full page larger than one tile is an explicit, labeled set of tiles.',
  },
  {
    id: 'full-page-met',
    owner: 'FEAT-058',
    measure: (run) => ({
      outcome: taskOutcomeOf(run),
      item: requirementsOf(run)?.['artifact:screenshot:full_page']?.status ?? null,
    }),
    target: equals({ outcome: 'fulfilled', item: 'met' }),
    note: 'S6: a complete set meets the full-page item.',
  },
  {
    id: 'every-tile-on-disk',
    owner: 'FEAT-058',
    measure: (run) => ({
      disk: onDiskCaptures(run),
      brief: briefArtifactsOf(run).map((entry) => `${String(entry.part)}/${String(entry.parts)}`),
    }),
    target: equals({ disk: { files: 3, matching: 3 }, brief: ['1/3', '2/3', '3/3'] }),
    note: 'S11: every tile is saved, audited, and listed in the Brief.',
  },
];

export const captureFullPageTall: Scenario = {
  id: 'capture-full-page-tall',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_URL, 'the whole page'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    declareStep(captureContract('full_page')),
    openStep(TALL_URL),
    fillNameStep(),
    captureStep('full_page'),
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
