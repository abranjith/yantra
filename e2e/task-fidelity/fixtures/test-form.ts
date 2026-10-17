/**
 * `test-form`: one long, generic, labeled form that must be filled without
 * being submitted (FEAT-054).
 *
 * The pattern: a single-page application form with more fillable controls
 * than the model-visible observation cap — text, email, telephone, password,
 * URL, and date inputs, native selects, a radio group in a `fieldset`, check
 * boxes, and a text area — plus the controls an honest "fill every field"
 * must leave alone (disabled, read-only, file upload, hidden), a typeless
 * submit button, and a `type="button"` control that does not submit.
 *
 * Submission is measurable from the server side, so nothing has to be read
 * back from a browser that has already been torn down: a real submission
 * navigates to {@link TEST_FORM_SUBMITTED_PATH}, and every submit event,
 * `requestSubmit()` call, and `submit()` call beacons
 * {@link TEST_FORM_SUBMIT_EVENT_PATH} first. Zero requests to either path is
 * the "no submission handler fired" measurement.
 *
 * It recreates no real page and names no site.
 */

import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  type RenderedPage,
} from './html.js';

export const TEST_FORM_PATTERN =
  'A long single-page application form, larger than the observation cap, to be filled and not submitted.';
export const TEST_FORM_PROVENANCE = { run: '20261014T023539Z', gaps: ['G4'] } as const;

/** The form page's path. */
export const TEST_FORM_PATH = '/apply';

/**
 * A short form with the same two buttons and submission counter, whose submit
 * button is inside the observation cap: the no-submit scenario clicks it
 * today, while reaching the long form's buttons is FEAT-055's continuation.
 */
export const TEST_FORM_SHORT_PATH = '/quick-apply';

/** Where a real submission of the form navigates. */
export const TEST_FORM_SUBMITTED_PATH = '/apply/submitted';

/** Beaconed by every submit event and programmatic submit, before it happens. */
export const TEST_FORM_SUBMIT_EVENT_PATH = '/apply/submit-event';

/**
 * Every page the site serves, as `path?query`. The submit beacon is served too,
 * but it is an empty 204 endpoint, not a page.
 */
export const TEST_FORM_ROUTES: readonly string[] = Object.freeze([
  '/',
  TEST_FORM_PATH,
  TEST_FORM_SUBMITTED_PATH,
  TEST_FORM_SHORT_PATH,
]);

/** One labeled text-like input. */
interface TextControl {
  readonly label: string;
  readonly type: 'text' | 'email' | 'tel' | 'password' | 'url' | 'date';
}

/** The contact section: explicitly labeled inputs of several types. */
const CONTACT: readonly TextControl[] = [
  { label: 'First name', type: 'text' },
  { label: 'Last name', type: 'text' },
  { label: 'Email address', type: 'email' },
  { label: 'Phone number', type: 'tel' },
  { label: 'Password', type: 'password' },
  { label: 'Confirm password', type: 'password' },
  { label: 'Date of birth', type: 'date' },
  { label: 'Personal website', type: 'url' },
];

/** The address section's text inputs (the country is a select). */
const ADDRESS: readonly TextControl[] = [
  { label: 'Street address', type: 'text' },
  { label: 'Address line 2', type: 'text' },
  { label: 'City', type: 'text' },
  { label: 'State or province', type: 'text' },
  { label: 'Postal code', type: 'text' },
];

/** How many numbered answer inputs the questionnaire section has. */
export const TEST_FORM_ANSWER_COUNT = 32;

/** The questionnaire section: many plain inputs, pushing the form past the cap. */
const ANSWERS: readonly TextControl[] = Array.from(
  { length: TEST_FORM_ANSWER_COUNT },
  (_, index) => ({ label: `Answer ${index + 1}`, type: 'text' as const }),
);

const COUNTRIES = ['Choose a country', 'Atlantis', 'Borduria', 'Elbonia', 'Freedonia'] as const;
const CONTACT_TIMES = ['Morning', 'Afternoon', 'Evening'] as const;
const PLANS = ['Basic', 'Standard', 'Premium'] as const;

/**
 * Every fillable control's label, grouped controls once: what "fill every
 * eligible field" must cover.
 */
export const TEST_FORM_ELIGIBLE_FIELDS: readonly string[] = Object.freeze([
  ...CONTACT.map((control) => control.label),
  ...ADDRESS.map((control) => control.label),
  'Country',
  ...ANSWERS.map((control) => control.label),
  'Preferred contact time',
  'Plan',
  'Subscribe to the newsletter',
  'I accept the terms',
  'Start date',
  'Comments',
]);

/** Controls the engine must leave out, with why. */
export const TEST_FORM_EXEMPT_FIELDS = Object.freeze({
  'Account number': 'disabled',
  'Reference code': 'read_only',
  Attachment: 'file_input',
} as const);

/** The submit control's name and the non-submitting button's name. */
export const TEST_FORM_SUBMIT_NAME = 'Send application';
export const TEST_FORM_ADD_ANOTHER_NAME = 'Add another reference';

/**
 * Render one `test-form` route, or null for an unknown path.
 *
 * @param path URL pathname.
 * @param _query URL search parameters (unused).
 */
export function renderTestForm(path: string, _query: URLSearchParams): RenderedPage | null {
  if (path === TEST_FORM_PATH) return htmlPage(formPage());
  if (path === TEST_FORM_SUBMITTED_PATH) return htmlPage(submittedPage());
  if (path === TEST_FORM_SHORT_PATH) return htmlPage(shortFormPage());
  if (path === TEST_FORM_SUBMIT_EVENT_PATH) {
    return { status: 204, contentType: 'text/plain; charset=utf-8', body: '' };
  }
  if (path === '/') {
    return homePage({
      header: header(),
      title: 'Membership application',
      intro: 'Apply for membership with one form.',
      links: [{ href: TEST_FORM_PATH, text: 'Application form' }],
    });
  }
  return null;
}

function header(): string {
  return headerComment(
    'test-form',
    TEST_FORM_PATTERN,
    `run ${TEST_FORM_PROVENANCE.run}, gaps ${TEST_FORM_PROVENANCE.gaps.join(', ')}`,
  );
}

function slug(label: string): string {
  return label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

function textInput(control: TextControl): string {
  const id = slug(control.label);
  return (
    `<p><label for="${id}">${escapeHtml(control.label)}</label> ` +
    `<input id="${id}" name="${id}" type="${control.type}"></p>`
  );
}

function select(label: string, options: readonly string[]): string {
  const id = slug(label);
  return (
    `<p><label for="${id}">${escapeHtml(label)}</label> <select id="${id}" name="${id}">` +
    options.map((option) => `<option>${escapeHtml(option)}</option>`).join('') +
    '</select></p>'
  );
}

/** Counts every way the form could be submitted, beaconing before it happens. */
const SUBMIT_COUNTER = `<script>
(() => {
  const beacon = () => { navigator.sendBeacon('${TEST_FORM_SUBMIT_EVENT_PATH}'); };
  document.addEventListener('submit', beacon, true);
  const requestSubmit = HTMLFormElement.prototype.requestSubmit;
  HTMLFormElement.prototype.requestSubmit = function (...args) {
    beacon();
    return requestSubmit.apply(this, args);
  };
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    beacon();
    return submit.apply(this);
  };
})();
</script>`;

function formPage(): string {
  return htmlDocument({
    header: header(),
    title: 'Membership application',
    head: SUBMIT_COUNTER,
    body: [
      '<main>',
      '<h1>Membership application</h1>',
      '<p>Complete every section, then send the application.</p>',
      `<form id="application" action="${TEST_FORM_SUBMITTED_PATH}" method="get">`,
      '<fieldset><legend>Contact details</legend>',
      ...CONTACT.map(textInput),
      '</fieldset>',
      '<fieldset><legend>Address</legend>',
      ...ADDRESS.map(textInput),
      select('Country', COUNTRIES),
      '</fieldset>',
      '<fieldset><legend>Questionnaire</legend>',
      ...ANSWERS.map(textInput),
      '</fieldset>',
      '<fieldset><legend>Preferences</legend>',
      select('Preferred contact time', CONTACT_TIMES),
      '<fieldset><legend>Plan</legend>',
      ...PLANS.map(
        (plan) =>
          `<label><input type="radio" name="plan" value="${slug(plan)}"> ${escapeHtml(plan)}</label>`,
      ),
      '</fieldset>',
      '<p><label><input type="checkbox" name="newsletter"> Subscribe to the newsletter</label></p>',
      '<p><label><input type="checkbox" name="terms"> I accept the terms</label></p>',
      textInput({ label: 'Start date', type: 'date' }),
      '<p><label for="comments">Comments</label> <textarea id="comments" name="comments"></textarea></p>',
      '</fieldset>',
      '<fieldset><legend>Office use</legend>',
      '<p><label for="account-number">Account number</label> <input id="account-number" name="account-number" disabled></p>',
      '<p><label for="reference-code">Reference code</label> <input id="reference-code" name="reference-code" value="REF-0001" readonly></p>',
      '<p><label for="attachment">Attachment</label> <input id="attachment" name="attachment" type="file"></p>',
      '<input type="hidden" name="form-token" value="synthetic">',
      '</fieldset>',
      `<p><button type="button">${escapeHtml(TEST_FORM_ADD_ANOTHER_NAME)}</button></p>`,
      `<p><button>${escapeHtml(TEST_FORM_SUBMIT_NAME)}</button></p>`,
      '</form>',
      '</main>',
    ].join('\n'),
  });
}

function shortFormPage(): string {
  return htmlDocument({
    header: header(),
    title: 'Quick application',
    head: SUBMIT_COUNTER,
    body: [
      '<main>',
      '<h1>Quick application</h1>',
      `<form id="quick" action="${TEST_FORM_SUBMITTED_PATH}" method="get">`,
      ...CONTACT.slice(0, 3).map(textInput),
      `<p><button type="button">${escapeHtml(TEST_FORM_ADD_ANOTHER_NAME)}</button></p>`,
      `<p><button>${escapeHtml(TEST_FORM_SUBMIT_NAME)}</button></p>`,
      '</form>',
      '</main>',
    ].join('\n'),
  });
}

function submittedPage(): string {
  return htmlDocument({
    header: header(),
    title: 'Application received',
    body: '<main><h1>Application received</h1><p>Thank you.</p></main>',
  });
}
