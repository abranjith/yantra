/**
 * `capture-vision-unchanged`: with the grant and an image-capable model,
 * Vision Assist behaves as before, and deliverable capture still never sends
 * pixels (FEAT-058, plan §12). `browser_screenshot` returns one image block;
 * `browser_capture` returns none; the audit trail lists one image the model
 * saw and one capture kept locally, through the same normalizer `yantra audit`
 * reads.
 */

import { equals, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_URL,
  auditImagePayloads,
  auditRefsOf,
  captureContract,
  captureGoal,
  captureStep,
  declareStep,
  fillNameStep,
  imageBlocksByTool,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations } from './common.js';
import { requirementsOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'both-tools-registered',
    owner: 'FEAT-058',
    measure: (run) => ({
      capture: run.registeredTools.includes('browser_capture'),
      vision: run.registeredTools.includes('browser_screenshot'),
    }),
    target: equals({ capture: true, vision: true }),
    note: 'D2: two capabilities, two authorities; both registered when Vision Assist is on.',
  },
  {
    id: 'pixels-only-from-vision',
    owner: 'FEAT-058',
    measure: (run) => imageBlocksByTool(run),
    target: equals({ browser_screenshot: 1 }),
    note: 'Vision Assist returns exactly one image block; browser_capture returns none.',
  },
  {
    id: 'audit-splits-seen-and-kept',
    owner: 'FEAT-058',
    measure: (run) => {
      const refs = auditRefsOf(run);
      return {
        seen: refs.filter((ref) => ref.sent_to_model).length,
        kept: refs.filter((ref) => !ref.sent_to_model).length,
        pixels: auditImagePayloads(run),
      };
    },
    target: equals({ seen: 1, kept: 1, pixels: 0 }),
    note: 'S9: yantra audit lists one image the model saw and one capture kept locally.',
  },
  {
    id: 'vision-image-is-not-the-deliverable',
    owner: 'FEAT-058',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    target: equals('met'),
    note: 'S7: the item is met by the clean browser_capture, not by the marked image.',
  },
];

export const captureVisionUnchanged: Scenario = {
  id: 'capture-vision-unchanged',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_URL, 'what is visible'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  visionAssist: true,
  script: [
    declareStep(captureContract('viewport')),
    openStep(TALL_URL),
    fillNameStep(),
    { kind: 'call', tool: 'browser_screenshot', label: 'vision', params: {} },
    captureStep('viewport'),
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
