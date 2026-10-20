/** Authored form truth and shared acceptance gates, independent of runtime verdicts. */
import type { ScriptStep } from '../agent/scripted-provider.js';
import { gateExpectations } from '../expectations.js';
import { protectedDigest } from '../fixtures/form-state.js';
import type { ActionTruth, Scenario, ValueRule } from '../scenario.js';

import { VALUES } from './do-form-complete.js';

const slug = (label: string): string =>
  label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');
const nonempty = { kind: 'nonempty' } as const;
export const TEST_FORM_RULES: Readonly<Record<string, ValueRule>> = {
  'first-name': { kind: 'letters' },
  'last-name': { kind: 'letters' },
  'email-address': { kind: 'email' },
  'phone-number': nonempty,
  password: { kind: 'protected' },
  'confirm-password': { kind: 'protected' },
  'date-of-birth': { kind: 'date' },
  'personal-website': nonempty,
  'street-address': nonempty,
  'address-line-2': nonempty,
  city: { kind: 'letters' },
  'state-or-province': { kind: 'letters' },
  'postal-code': { kind: 'digits', min: 5, max: 5 },
  country: { kind: 'choice' },
  ...Object.fromEntries(
    Array.from({ length: 32 }, (_, index) => [`answer-${index + 1}`, nonempty]),
  ),
  'preferred-contact-time': { kind: 'choice' },
  'plan-basic': { kind: 'checked-any', group: 'plan' },
  'plan-standard': { kind: 'checked-any', group: 'plan' },
  'plan-premium': { kind: 'checked-any', group: 'plan' },
  newsletter: { kind: 'checked-any', group: 'newsletter' },
  terms: { kind: 'checked-any', group: 'terms' },
  'start-date': { kind: 'date' },
  comments: nonempty,
  'account-number': { kind: 'untouched' },
  'reference-code': { kind: 'untouched' },
  attachment: { kind: 'untouched' },
  'form-token': { kind: 'untouched' },
};

function intendedOf(steps: readonly ScriptStep[]): Record<string, string | boolean> {
  const intended: Record<string, string | boolean> = {};
  for (const step of steps) {
    if (
      step.kind !== 'call' ||
      step.tool !== 'browser_fill_form' ||
      typeof step.params === 'function'
    )
      continue;
    for (const field of (step.params.fields ?? []) as { field: string; value: string }[]) {
      const key = slug(field.field);
      if (TEST_FORM_RULES[key] !== undefined) intended[key] = field.value;
    }
  }
  return intended;
}

/** Keep original owner expectations intact; attach the same six gates once. */
export function withActionGate(scenario: Scenario): Scenario {
  return { ...scenario, expectations: [...scenario.expectations, ...gateExpectations(scenario)] };
}

/** Retrofit previously published form scenarios, preserving their existing partial-state baselines. */
export function retrofitActionGate(scenario: Scenario): Scenario {
  if (scenario.contract.actionTruth !== undefined) return withActionGate(scenario);
  const capture = scenario.id.startsWith('capture-');
  const formIds = [
    'do-form-complete',
    'do-form-historical',
    'do-claims-met-contrary',
    'do-fulfillment-omitted',
    'do-revision-drops-screenshot',
    'do-contract-missing',
    'do-submit-forbidden',
    'do-progress-partial-batch',
    'do-progress-stall-recovers',
    'do-progress-freeze-publishes',
    'do-progress-stall-ignored',
    'do-progress-autocomplete',
  ];
  if (!capture && !formIds.includes(scenario.id)) return scenario;
  let truth: ActionTruth;
  let expectOutcome: Scenario['expectOutcome'] = 'partial';
  let expectedCaptures: NonNullable<Scenario['expectedCaptures']> = [];
  if (capture) {
    const scope =
      scenario.id === 'capture-element-below-fold'
        ? 'element'
        : scenario.id.startsWith('capture-full-page')
          ? 'full_page'
          : 'viewport';
    truth = {
      page: scenario.id === 'capture-full-page-truncated' ? 'report/long' : 'report',
      rules: { name: { kind: 'letters' }, password: { kind: 'untouched' } },
      intended: { name: 'Ada Lovelace' },
      artifacts: [scope],
      submit: 'forbidden',
    };
    expectOutcome = ['capture-suppressed', 'capture-full-page-truncated'].includes(scenario.id)
      ? 'partial'
      : 'fulfilled';
    expectedCaptures = scenario.id === 'capture-suppressed' ? [] : [scope];
  } else if (scenario.id === 'do-progress-autocomplete') {
    truth = {
      page: 'progress/autocomplete',
      rules: { destination: { kind: 'choice' } },
      intended: { destination: 'North Region' },
      artifacts: [],
      submit: 'forbidden',
    };
    expectOutcome = 'fulfilled';
  } else if (scenario.id === 'do-submit-forbidden') {
    truth = {
      page: 'quick-apply',
      rules: {
        'first-name': { kind: 'untouched' },
        'last-name': { kind: 'untouched' },
        'email-address': { kind: 'untouched' },
      },
      intended: {},
      artifacts: [],
      submit: 'forbidden',
    };
    expectOutcome = 'fulfilled';
  } else {
    const intended = intendedOf(scenario.script);
    if (scenario.id === 'do-form-complete') {
      for (const [label, value] of VALUES) {
        const key =
          label === 'Subscribe to the newsletter'
            ? 'newsletter'
            : label === 'I accept the terms'
              ? 'terms'
              : slug(label);
        intended[key] =
          TEST_FORM_RULES[key]?.kind === 'protected'
            ? protectedDigest(value)
            : value === 'checked'
              ? true
              : value;
      }
      // Existing native-date-entry owner: these two native inputs honestly remain empty.
      intended['date-of-birth'] = '';
      intended['start-date'] = '';
      intended['plan-basic'] = false;
      intended['plan-premium'] = false;
      expectedCaptures = ['viewport'];
    }
    if (scenario.id === 'do-progress-stall-recovers') expectedCaptures = ['viewport'];
    truth = {
      page: 'apply',
      rules: TEST_FORM_RULES,
      intended,
      artifacts: ['viewport'],
      submit: 'forbidden',
    };
  }
  if (scenario.id === 'do-progress-stall-ignored') expectOutcome = 'failed';
  return withActionGate({
    ...scenario,
    expectOutcome,
    expectedCaptures,
    contract: { ...scenario.contract, actionTruth: truth },
  });
}
