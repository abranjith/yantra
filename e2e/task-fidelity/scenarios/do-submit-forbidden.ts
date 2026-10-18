/**
 * `do-submit-forbidden`: under `effects.submit: forbidden` the engine refuses
 * a click on the form's submit button before any confirmation prompt, and no
 * submission handler fires (FEAT-054). A button that does not submit still
 * clicks.
 *
 * It runs on the short variant of the form, whose buttons are inside the
 * observation cap; reaching the long form's buttons is FEAT-055's
 * continuation.
 */

import type { ScriptStep } from '../agent/scripted-provider.js';
import { equals, type Expectation } from '../expectations.js';
import { originOf } from '../fixtures/sites.js';
import {
  TEST_FORM_ADD_ANOTHER_NAME,
  TEST_FORM_SHORT_PATH,
  TEST_FORM_SUBMIT_NAME,
} from '../fixtures/test-form.js';
import type { Scenario } from '../scenario.js';

import { resultLabelled } from './common.js';
import {
  FORM_CONTRACT,
  FORM_HOST,
  contractStep,
  formExpectations,
  publishFormStep,
  requirementsOf,
} from './do-form.js';

const SHORT_FORM_URL = `${originOf('test-form')}${TEST_FORM_SHORT_PATH}`;

/** Clicks the control named `name` from the latest observation. */
function clickStep(name: string, label: string): ScriptStep {
  return {
    kind: 'call',
    tool: 'browser_click',
    label,
    params: (ctx) => {
      const observation = ctx.last('browser_observe')?.model as
        { interactables?: { ref?: unknown; name?: unknown }[] } | undefined;
      const ref = observation?.interactables?.find((entry) => entry.name === name)?.ref;
      return typeof ref === 'string' ? { ref } : null;
    },
  };
}

const expectations: readonly Expectation[] = [
  ...formExpectations(),
  {
    id: 'submit-refused',
    owner: 'FEAT-054',
    measure: (run) => {
      const result = resultLabelled(run, 'click submit');
      return { status: result?.status ?? null, code: result?.errorCode ?? null };
    },
    target: equals({ status: 'error', code: 'SUBMIT_FORBIDDEN' }),
    note: 'Plan §7: a submit-class click is refused by the engine under forbidden.',
  },
  {
    id: 'no-confirmation-prompt',
    owner: 'FEAT-054',
    measure: (run) => run.confirmationRequests,
    target: equals(0),
    note: 'Plan §7: the refusal happens before the confirmation gate; no prompt is built.',
  },
  {
    id: 'non-submit-button-clicks',
    owner: 'FEAT-054',
    measure: (run) => resultLabelled(run, 'click add another')?.status ?? null,
    target: equals('ok'),
    note: 'Plan §8 risk: the structural signal must not misfire on a type="button" control.',
  },
  {
    id: 'submit-item-met',
    owner: 'FEAT-054',
    measure: (run) => requirementsOf(run)?.['effects.submit']?.status ?? null,
    target: equals('met'),
    note: 'The refused attempt leaves the no-submit requirement met.',
  },
  {
    id: 'clicks-reachable',
    owner: 'FEAT-054',
    measure: (run) => run.unreachable,
    target: equals([]),
    note: 'Both buttons are in the short form observation.',
  },
];

export const doSubmitForbidden: Scenario = {
  id: 'do-submit-forbidden',
  sites: ['test-form'],
  command: 'do',
  goal: `Fill in the form at ${SHORT_FORM_URL}, but do not submit it.`,
  contract: FORM_CONTRACT,
  userLocation: null,
  serps: [],
  script: [
    contractStep({
      deliverable: 'actions',
      subject: 'the quick application form',
      required_sources: [FORM_HOST],
      effects: { submit: 'forbidden' },
    }),
    { kind: 'call', tool: 'browser_navigate', label: 'open form', params: { url: SHORT_FORM_URL } },
    { kind: 'call', tool: 'browser_observe', label: 'observe', params: {} },
    clickStep(TEST_FORM_SUBMIT_NAME, 'click submit'),
    { kind: 'call', tool: 'browser_observe', label: 'observe again', params: {} },
    clickStep(TEST_FORM_ADD_ANOTHER_NAME, 'click add another'),
    publishFormStep(),
  ],
  expectations,
  tiers: ['deterministic'],
  timeoutMs: 180_000,
  truth: () => [],
};
