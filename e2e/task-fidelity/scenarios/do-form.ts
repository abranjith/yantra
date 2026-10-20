/**
 * Shared steps and measures for the FEAT-054 `do` form scenarios.
 *
 * Every scenario drives the synthetic `test-form` site through the real
 * browser tools and judges the run only by what the engine recorded: the
 * outcome, the Brief's per-item requirements, the manifest, and the fixture
 * server's own request log (a submission would reach it).
 */

import { exitCodeForAgenticOutcome, outcomeFirstLine } from '@yantra/agent';

import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import {
  TEST_FORM_PATH,
  TEST_FORM_SUBMITTED_PATH,
  TEST_FORM_SUBMIT_EVENT_PATH,
} from '../fixtures/test-form.js';
import type { ScenarioRun } from '../runner.js';
import type { ScenarioContract } from '../scenario.js';

import { briefOf, crossCuttingExpectations, noticesOf } from './common.js';

/** The form page the goal names. */
export const FORM_URL = `${originOf('test-form').replace('http:', 'https:')}${TEST_FORM_PATH}`;

/** The form's host, as a contract names it. */
export const FORM_HOST = 'test-form.yantra.test';

/** The harness's ground-truth contract for a fill-without-submitting goal. */
export const FORM_CONTRACT: ScenarioContract = {
  deliverable: 'actions',
  requiredFields: [],
  filters: [],
  requiredSources: [FORM_HOST],
};

/** The goal every form scenario states. */
export const FORM_GOAL =
  `Fill every field of the form at ${FORM_URL} with suitable test data and take a ` +
  'screenshot, but do not submit it.';

/** The contract a faithful run declares for {@link FORM_GOAL}. */
export const FULL_ACTIONS_CONTRACT = {
  deliverable: 'actions',
  subject: 'the membership application form',
  required_sources: [FORM_HOST],
  fill: { coverage: 'all_eligible' },
  artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
  effects: { submit: 'forbidden' },
} as const;

/** The goal's capture and no-submit terms, without the fill-coverage item. */
export const CAPTURE_CONTRACT = {
  deliverable: 'actions',
  subject: 'the membership application form',
  required_sources: [FORM_HOST],
  artifacts: [{ kind: 'screenshot', scope: 'viewport' }],
  effects: { submit: 'forbidden' },
} as const;

/** Declares a contract. */
export function contractStep(
  params: Readonly<Record<string, unknown>>,
  label = 'contract',
): ScriptStep {
  return { kind: 'call', tool: 'task_contract', label, params };
}

/** Opens the form. */
export const NAVIGATE_STEP: ScriptStep = {
  kind: 'call',
  tool: 'browser_navigate',
  label: 'open form',
  params: { url: FORM_URL },
};

/** Fills the numbered answers `from..to` in one batch. */
export function fillAnswersStep(from: number, to: number, label = 'fill'): ScriptStep {
  const fields = [];
  for (let n = from; n <= to; n += 1)
    fields.push({ field: `Answer ${n}`, value: `Sample answer ${n}` });
  return { kind: 'call', tool: 'browser_fill_form', label, params: { fields } };
}

/** Publishes the Brief, with an optional `fulfillment` claim. */
export function publishFormStep(
  fulfillment?: {
    readonly met: boolean;
    readonly unmet: readonly { item: string; reason: string }[];
  },
  label = 'publish',
): ScriptStep {
  return {
    kind: 'call',
    tool: 'result_publish',
    label,
    params: {
      brief: {
        title: 'Membership application',
        overview: 'Filled the application form with test data; it was not submitted.',
        ...(fulfillment === undefined ? {} : { fulfillment }),
      },
    },
  };
}

/** The settled task-outcome word, or the outcome kind when nothing was published. */
export function taskOutcomeOf(run: ScenarioRun): string {
  return run.outcome.kind === 'published' ? run.outcome.taskOutcome : run.outcome.kind;
}

/** The first terminal line of a published run, or null. */
export function firstLineOf(run: ScenarioRun): string | null {
  return run.outcome.kind === 'published' ? outcomeFirstLine(run.outcome) : null;
}

/** The Brief's requirements as `id → { status, declared_in }`, or null without any. */
export function requirementsOf(
  run: ScenarioRun,
): Readonly<Record<string, { readonly status: unknown; readonly declared_in: unknown }>> | null {
  const requirements = briefOf(run)?.requirements;
  if (!Array.isArray(requirements)) return null;
  return Object.fromEntries(
    requirements.map((entry: unknown) => {
      const item = entry as { id?: unknown; status?: unknown; declared_in?: unknown };
      return [String(item.id), { status: item.status, declared_in: item.declared_in }];
    }),
  );
}

/** The manifest's outcome fields. */
export function manifestOutcomeOf(run: ScenarioRun): Readonly<Record<string, unknown>> {
  const manifest = (run.artifacts.manifest ?? {}) as Record<string, unknown>;
  return {
    status: manifest.status,
    failureClass: manifest.failureClass,
    taskOutcome: manifest.taskOutcome,
    terminationReason: manifest.terminationReason,
  };
}

/** Requests that would mean the form was submitted: a navigation or a submit beacon. */
export function submissionsOf(run: ScenarioRun): number {
  return run.requests.filter(
    (entry) =>
      entry.host === FORM_HOST &&
      (entry.path === TEST_FORM_SUBMITTED_PATH || entry.path === TEST_FORM_SUBMIT_EVENT_PATH),
  ).length;
}

/** Expectations every form scenario carries: the cross-cutting ones plus no submission. */
export function formExpectations(): readonly Expectation[] {
  return [
    ...crossCuttingExpectations(),
    {
      id: 'no-submission',
      owner: 'FEAT-054',
      measure: (run) => submissionsOf(run),
      target: equals(0),
      note: 'Plan §7: the form is never submitted; no submission handler fires.',
    },
  ];
}

/** The exit code the CLI would return for the run. */
export function exitCodeOf(run: ScenarioRun): number {
  return exitCodeForAgenticOutcome(run.outcome);
}

/** The Brief's notice sources, in order. */
export function noticeSourcesOf(run: ScenarioRun): readonly string[] {
  return noticesOf(run).map((notice) => notice.source);
}
