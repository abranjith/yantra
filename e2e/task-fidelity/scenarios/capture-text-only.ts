/**
 * `capture-text-only`: the fresh-install acceptance (FEAT-058, plan §12). A
 * text-only model with no `context.screenshots` grant asks for a screenshot:
 * the run saves a clean PNG locally, links it from the Brief, sends the
 * provider no image, and meets the item.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_URL,
  auditImagePayloads,
  briefArtifactsOf,
  captureContract,
  captureGoal,
  captureStep,
  declareStep,
  fillNameStep,
  imageBlocksByTool,
  onDiskCaptures,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations } from './common.js';
import { exitCodeOf, requirementsOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'fulfilled',
    owner: 'FEAT-058',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'fulfilled', exit: 0 }),
    note: 'G7: a requested screenshot is delivered on a fresh install with a text-only model.',
  },
  {
    id: 'screenshot-met',
    owner: 'FEAT-058',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    target: equals('met'),
    note: 'S7: a clean browser_capture after the last action meets the viewport item.',
  },
  {
    id: 'capture-tool-without-vision',
    owner: 'FEAT-058',
    measure: (run) => ({
      capture: run.registeredTools.includes('browser_capture'),
      vision: run.registeredTools.includes('browser_screenshot'),
    }),
    target: equals({ capture: true, vision: false }),
    note: 'D2: deliverable capture needs no grant; Vision Assist stays behind its gate.',
  },
  {
    id: 'png-matches-audit',
    owner: 'FEAT-058',
    measure: (run) => onDiskCaptures(run),
    target: equals({ files: 1, matching: 1 }),
    note: 'One PNG on disk, whose SHA-256 is the one tool-calls.jsonl cites.',
  },
  {
    id: 'no-image-reaches-the-provider',
    owner: 'FEAT-058',
    measure: (run) => ({
      received: imageBlocksByTool(run),
      audited: auditImagePayloads(run),
    }),
    target: equals({ received: {}, audited: 0 }),
    note: 'D2: the provider session and the audit trail carry no pixels.',
  },
  {
    id: 'brief-links-the-capture',
    owner: 'FEAT-058',
    measure: (run) => briefArtifactsOf(run).map((entry) => [entry.scope, entry.part, entry.parts]),
    target: equals([['viewport', 1, 1]]),
    note: 'S11: the Brief lists the saved capture.',
  },
  {
    id: 'model-sees-metadata-only',
    owner: 'FEAT-058',
    measure: (run) => run.toolResults.find((entry) => entry.label === 'capture')?.modelText ?? '',
    target: satisfies(
      'names the saved path and carries no hash or image data',
      (text) =>
        typeof text === 'string' &&
        text.includes('screenshots/capture-1-') &&
        text.includes('"saved_locally":true') &&
        !/sha256|base64|data:image/u.test(text),
    ),
    note: 'D2: the model receives path, size, and labels, never pixels or a hash.',
  },
];

export const captureTextOnly: Scenario = {
  id: 'capture-text-only',
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
    captureStep('viewport'),
    publishCaptureStep(true),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
