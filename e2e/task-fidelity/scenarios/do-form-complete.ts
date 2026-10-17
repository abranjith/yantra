/**
 * `do-form-complete`: a faithful run of the form goal (FEAT-054). It fills
 * every eligible field of a form larger than the observation cap in batches
 * of ten, captures the viewport after the last fill (Vision Assist granted,
 * with an image-capable model), and publishes without submitting.
 *
 * `fulfilled` needs FEAT-055 TASK-001's census of the whole form as the fill
 * item's denominator; until it lands the fill is honestly "not counted" and
 * the run is `partial`. FEAT-058 later moves the capture to `browser_capture`
 * with no grant.
 */

import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import { TEST_FORM_ANSWER_COUNT } from '../fixtures/test-form.js';
import type { ScenarioRun } from '../runner.js';
import type { Scenario } from '../scenario.js';

import { resultsLabelled } from './common.js';
import {
  FORM_CONTRACT,
  FORM_GOAL,
  FULL_ACTIONS_CONTRACT,
  NAVIGATE_STEP,
  contractStep,
  exitCodeOf,
  formExpectations,
  publishFormStep,
  requirementsOf,
  taskOutcomeOf,
} from './do-form.js';

/** Synthetic test data for every eligible control, by label. */
const VALUES: readonly (readonly [string, string])[] = [
  ['First name', 'Ada'],
  ['Last name', 'Lovelace'],
  ['Email address', 'ada@example.test'],
  ['Phone number', '555-0100'],
  ['Password', 'Synthetic-Pass-123'],
  ['Confirm password', 'Synthetic-Pass-123'],
  ['Date of birth', '1990-01-02'],
  ['Personal website', 'https://example.test'],
  ['Street address', '1 Test Street'],
  ['Address line 2', 'Suite 2'],
  ['City', 'Testville'],
  ['State or province', 'Test State'],
  ['Postal code', '00000'],
  ['Country', 'Elbonia'],
  ...Array.from(
    { length: TEST_FORM_ANSWER_COUNT },
    (_, index) => [`Answer ${index + 1}`, `Sample answer ${index + 1}`] as const,
  ),
  ['Preferred contact time', 'Evening'],
  ['Plan', 'Standard'],
  ['Subscribe to the newsletter', 'checked'],
  ['I accept the terms', 'checked'],
  ['Start date', '2026-11-01'],
  ['Comments', 'Synthetic test data.'],
];

/** The values in batches of ten, the stated per-call cap. */
function fillBatches(): ScriptStep[] {
  const steps: ScriptStep[] = [];
  for (let start = 0; start < VALUES.length; start += 10) {
    steps.push({
      kind: 'call',
      tool: 'browser_fill_form',
      label: 'fill batch',
      params: {
        fields: VALUES.slice(start, start + 10).map(([field, value]) => ({ field, value })),
      },
    });
  }
  return steps;
}

const PROTECTED_FIELDS = ['Password', 'Confirm password'] as const;
const DATE_FIELDS = ['Date of birth', 'Start date'] as const;
const GROUP_FIELDS = ['Plan'] as const;

/** Failed fills as `<field>: <code>`, limited to `fields` (all when null). */
function failuresFor(run: ScenarioRun, fields: readonly string[] | null): string[] {
  return resultsLabelled(run, 'fill batch').flatMap((result) => {
    const model = result.model as { failed?: { field?: unknown; error_code?: unknown }[] } | null;
    return (model?.failed ?? [])
      .filter((entry) => fields === null || fields.includes(String(entry.field)))
      .map((entry) => `${String(entry.field)}: ${String(entry.error_code)}`);
  });
}

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'fulfilled',
    owner: 'FEAT-055',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'fulfilled', exit: 0 }),
    baseline: equals({ outcome: 'partial', exit: 2 }),
    note: 'Plan §12: a fully filled form with its capture is fulfilled once the census counts it.',
  },
  {
    id: 'screenshot-met',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    target: equals('met'),
    note: 'A capture after the last fill, on the same document, meets the viewport item.',
  },
  {
    id: 'submit-item-met',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['effects.submit']?.status ?? null,
    target: equals('met'),
    note: 'Filling never submits.',
  },
  {
    id: 'protected-fields-commit',
    owner: 'FEAT-056',
    measure: (run) => failuresFor(run, PROTECTED_FIELDS),
    target: equals([]),
    baseline: equals(['Password: WIDGET_NOT_COMMITTED', 'Confirm password: WIDGET_NOT_COMMITTED']),
    note: 'G5: a masked control reports a false commit failure for caller-supplied test data.',
  },
  {
    id: 'native-date-fields-commit',
    owner: 'FEAT-056',
    measure: (run) => failuresFor(run, DATE_FIELDS),
    target: equals([]),
    baseline: equals(['Date of birth: WIDGET_NOT_COMMITTED', 'Start date: WIDGET_NOT_COMMITTED']),
    note: 'A native date input reports not committed; the readback verdict is unverified (TODO).',
  },
  {
    id: 'fieldset-group-resolves',
    owner: 'FEAT-055',
    measure: (run) => failuresFor(run, GROUP_FIELDS),
    target: equals([]),
    baseline: equals(['Plan: FORM_FIELD_NOT_FOUND']),
    note: 'Plan §12 FEAT-055 Part B: a radio group is named by its fieldset legend.',
  },
  {
    id: 'other-fields-commit',
    owner: 'FEAT-054',
    measure: (run) =>
      failuresFor(run, null).filter(
        (failure) =>
          ![...PROTECTED_FIELDS, ...DATE_FIELDS, ...GROUP_FIELDS].some((field) =>
            failure.startsWith(`${field}:`),
          ),
      ),
    target: equals([]),
    note: 'Every other eligible control takes its value in batches of ten.',
  },
];

export const doFormComplete: Scenario = {
  id: 'do-form-complete',
  sites: ['test-form'],
  command: 'do',
  goal: FORM_GOAL,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  visionAssist: true,
  script: [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    ...fillBatches(),
    { kind: 'call', tool: 'browser_screenshot', label: 'capture', params: {} },
    publishFormStep({ met: true, unmet: [] }),
  ],
  expectations,
  tiers: ['deterministic'],
  // Fifty-odd real-Chrome fills, each waiting out the suggestion window,
  // until FEAT-057 makes plain fills cheap.
  timeoutMs: 600_000,
  truth: () => [],
};
