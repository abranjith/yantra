/**
 * `do-form-complete`: a faithful run of the form goal (FEAT-054). It fills
 * every eligible field of a form larger than the observation cap in batches
 * of ten, saves a clean viewport capture with `browser_capture` after the last
 * fill (no screenshot grant, a text-only model: FEAT-058), and publishes
 * without submitting.
 *
 * FEAT-055 supplies the whole-form denominator and FEAT-056 verifies the
 * protected fields in page. `fulfilled` additionally needs the native date
 * fields to commit (owner `native-date-entry`); until then the run is honestly
 * `partial`.
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
  ['Plan Standard', 'checked'],
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
const GROUP_FIELDS = ['Plan Standard'] as const;

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
    owner: 'native-date-entry',
    measure: (run) => ({ outcome: taskOutcomeOf(run), exit: exitCodeOf(run) }),
    target: equals({ outcome: 'fulfilled', exit: 0 }),
    baseline: equals({ outcome: 'partial', exit: 2 }),
    note: 'A counted form with its capture is fulfilled once its native date fields commit; protected fields already verify (FEAT-056).',
  },
  {
    id: 'screenshot-met',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['artifact:screenshot:viewport']?.status ?? null,
    target: equals('met'),
    note: 'A clean browser_capture after the last fill, on the same document, meets the viewport item (FEAT-058 S7).',
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
    note: 'G5: a masked control filled with caller-supplied test data verifies in page instead of reporting a false commit failure.',
  },
  {
    id: 'native-date-fields-commit',
    owner: 'native-date-entry',
    measure: (run) => failuresFor(run, DATE_FIELDS),
    target: equals([]),
    baseline: equals(['Date of birth: WIDGET_NOT_COMMITTED', 'Start date: WIDGET_NOT_COMMITTED']),
    note: 'A native date input stays empty after the typed entry, so it honestly reports not committed (TODO).',
  },
  {
    id: 'fieldset-group-resolves',
    owner: 'FEAT-055',
    measure: (run) => failuresFor(run, GROUP_FIELDS),
    target: equals([]),
    note: 'FEAT-055 Part B: the fieldset section qualifies the radio option, without guessing among group members.',
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
  script: [
    contractStep(FULL_ACTIONS_CONTRACT),
    NAVIGATE_STEP,
    ...fillBatches(),
    { kind: 'call', tool: 'browser_capture', label: 'capture', params: { scope: 'viewport' } },
    publishFormStep({ met: true, unmet: [] }),
  ],
  expectations,
  tiers: ['deterministic'],
  // Fifty-odd real-Chrome fills, each waiting out the suggestion window,
  // until FEAT-057 makes plain fills cheap.
  timeoutMs: 600_000,
  truth: () => [],
};
