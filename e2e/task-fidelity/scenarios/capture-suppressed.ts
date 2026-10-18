/**
 * `capture-suppressed`: `--no-screenshots` (FEAT-058, plan §12). Neither
 * capture tool is registered; the contract declaration discloses the gap at
 * once, on its result and as a progress event; the run keeps going and ends
 * `partial`, naming the flag; the manifest and run health record why.
 */

import { equals, satisfies, type Expectation } from '../expectations.js';
import type { Scenario } from '../scenario.js';

import {
  CAPTURE_SCENARIO_CONTRACT,
  TALL_URL,
  captureContract,
  captureGoal,
  declareStep,
  fillNameStep,
  onDiskCaptures,
  openStep,
  publishCaptureStep,
} from './capture-common.js';
import { crossCuttingExpectations, healthOf } from './common.js';
import { exitCodeOf, taskOutcomeOf } from './do-form.js';

const expectations: readonly Expectation[] = [
  ...crossCuttingExpectations(),
  {
    id: 'no-capture-tool',
    owner: 'FEAT-058',
    measure: (run) =>
      run.registeredTools.filter(
        (name) => name === 'browser_capture' || name === 'browser_screenshot',
      ),
    target: equals([]),
    note: 'D2: --no-screenshots removes both capture tools for the run.',
  },
  {
    id: 'gap-on-the-declaration',
    owner: 'FEAT-058',
    measure: (run) =>
      (
        run.toolResults.find((entry) => entry.label === 'contract')?.model as {
          capability_gaps?: unknown;
        } | null
      )?.capability_gaps ?? null,
    target: equals([{ item: 'artifact:screenshot:viewport', reason: 'suppressed_by_flag' }]),
    note: 'G7: the declared screenshot is disclosed as undeliverable the moment it is declared.',
  },
  {
    id: 'one-gap-event',
    owner: 'FEAT-058',
    measure: (run) =>
      run.progress
        .filter((event) => event.type === 'capability_gap')
        .map((event) => ('summary' in event ? event.summary : '')),
    target: equals([
      'Cannot deliver: viewport screenshot. Screenshots are off for this run (--no-screenshots); continuing with the other requirements.',
    ]),
    note: 'One stderr disclosure, right after the contract echo.',
  },
  {
    id: 'partial-naming-the-flag',
    owner: 'FEAT-058',
    measure: (run) => ({
      outcome: taskOutcomeOf(run),
      exit: exitCodeOf(run),
      reason:
        run.outcome.kind === 'published'
          ? (run.outcome.requirements?.unmet.find(
              (item) => item.id === 'artifact:screenshot:viewport',
            )?.reason ?? null)
          : null,
    }),
    target: equals({
      outcome: 'partial',
      exit: 2,
      reason: 'not captured (screenshots are off for this run (--no-screenshots))',
    }),
    note: 'The run continues with the other items and ends partial with the flag named.',
  },
  {
    id: 'manifest-records-why',
    owner: 'FEAT-058',
    measure: (run) =>
      (
        (run.artifacts.manifest as { agent?: { capture?: { deliverable?: unknown } } } | null)
          ?.agent?.capture?.deliverable as { reasons?: unknown } | undefined
      )?.reasons ?? null,
    target: equals(['suppressed_by_flag']),
    note: 'G7: the manifest records which gate kept deliverable capture off.',
  },
  {
    id: 'run-health-records-why',
    owner: 'FEAT-058',
    measure: (run) => healthOf(run)?.capture ?? null,
    target: satisfies(
      'records suppressed_by_flag for both capabilities and zero deliverable calls',
      (value) => {
        const capture = value as {
          vision_assist?: { reasons?: unknown[] };
          deliverable?: { reasons?: unknown[] };
          deliverable_calls?: unknown;
        } | null;
        return (
          capture?.deliverable?.reasons?.join() === 'suppressed_by_flag' &&
          capture.vision_assist?.reasons?.includes('suppressed_by_flag') === true &&
          capture.deliverable_calls === 0
        );
      },
    ),
    note: 'Plan §11: run-health.json carries both decisions as closed codes.',
  },
  {
    id: 'nothing-on-disk',
    owner: 'FEAT-058',
    measure: (run) => onDiskCaptures(run),
    target: equals({ files: 0, matching: 0 }),
    note: 'A suppressed run writes no capture.',
  },
];

export const captureSuppressed: Scenario = {
  id: 'capture-suppressed',
  sites: ['tall-page'],
  command: 'do',
  goal: captureGoal(TALL_URL, 'what is visible'),
  contract: CAPTURE_SCENARIO_CONTRACT,
  userLocation: null,
  serps: [],
  screenshotsSuppressed: true,
  script: [
    declareStep(captureContract('viewport')),
    openStep(TALL_URL),
    fillNameStep(),
    publishCaptureStep(false, ['screenshot']),
  ],
  expectations,
  tiers: ['deterministic'],
  truth: () => [],
};
