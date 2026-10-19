/** Synthetic layout forms; provenance: FEAT-055 layout matrix, plan gaps G2 and G8. */
import { readFileSync } from 'node:fs';

import { layoutMatrix } from '@yantra/test-helpers/layout-matrix';

import type { ValueRule } from '../scenario.js';

import { FORM_STATE_SCRIPT } from './form-state.js';
import { headerComment, homePage, htmlPage, type RenderedPage } from './html.js';

export const FORM_LAB_PATTERN = 'layout-matrix form mutation and independent state measurement';
export const FORM_LAB_PROVENANCE = { gaps: ['G2', 'G8'] as const };
export const FORM_LAB_PAGES = [
  'table-label-cell',
  'css-order-grid',
  'repeated-sections',
  'over-cap',
  'fieldset-groups',
  'no-evidence',
  'dynamic-replacement',
  'mixed-form',
  'cite-actions',
  'recovery-groups',
] as const;
export const FORM_LAB_ROUTES = ['/', ...FORM_LAB_PAGES.map((id) => `/${id}`)];

const rangeMarkup = readFileSync(
  new URL(
    '../../../packages/core/tests/fixtures/widgets/shared-calendar-range.html',
    import.meta.url,
  ),
  'utf8',
);
const extraBodies: Readonly<Record<string, string>> = {
  'mixed-form':
    '<h1>Evidence form</h1><label>First name <input data-fixture-key="first"></label><div>Family name<input data-fixture-key="family"></div><label>Email <input type="email" data-fixture-key="email"></label><label>Region <select data-fixture-key="region"><option value="">Choose</option><option>North</option></select></label><label>Comments <textarea data-fixture-key="comments"></textarea></label><label>Password <input type="password" data-fixture-key="password"></label>',
  'cite-actions':
    '<h1>Evidence form</h1><label>First name <input data-fixture-key="first"></label><label>Email <input type="email" data-fixture-key="email"></label>',
  'recovery-groups':
    `<h1>Recovery form</h1><label>Name <input data-fixture-key="name"></label><label>Units <input type="number" max="10" data-fixture-key="units" oninput="if(!this.validity.valid)this.value='' "></label><div>Email<input data-fixture-key="email"></div><button type="button" onclick="const old=document.querySelector('[data-fixture-key=email]');const fresh=old.cloneNode();fresh.value='';old.replaceWith(fresh);fresh.dispatchEvent(new Event('change',{bubbles:true}));">Replace email</button>` +
    rangeMarkup
      .replace('id="from"', 'id="from" data-fixture-key="from" aria-controls="calendar"')
      .replace('id="to"', 'id="to" data-fixture-key="to" aria-controls="calendar"')
      .replaceAll('<button', '<button type="button"'),
};

const exempt: Record<string, ValueRule> = {
  disabled: { kind: 'untouched' },
  readonly: { kind: 'untouched' },
  file: { kind: 'untouched' },
};
/** Authored from each control's meaning, independent of runtime verification. */
export const BENCHMARK_RULES: Readonly<Record<string, Readonly<Record<string, ValueRule>>>> = {
  'table-label-cell': { first: { kind: 'letters' }, last: { kind: 'letters' }, ...exempt },
  'css-order-grid': { family: { kind: 'letters' }, given: { kind: 'letters' }, ...exempt },
  'repeated-sections': {
    'billing-city': { kind: 'letters' },
    'shipping-city': { kind: 'letters' },
    region: { kind: 'letters' },
    ...exempt,
  },
  'over-cap': {
    ...Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [`f${index}`, { kind: 'nonempty' } as const]),
    ),
    ...exempt,
  },
  'fieldset-groups': {
    email: { kind: 'checked-any', group: 'method' },
    phone: { kind: 'checked-any', group: 'method' },
    music: { kind: 'checked-any', group: 'interests' },
    art: { kind: 'checked-any', group: 'interests' },
    ...exempt,
  },
  'no-evidence': { a: { kind: 'nonempty' }, b: { kind: 'nonempty' }, ...exempt },
  'dynamic-replacement': { email: { kind: 'email' }, ...exempt },
  'mixed-form': {
    first: { kind: 'letters' },
    family: { kind: 'letters' },
    email: { kind: 'email' },
    region: { kind: 'choice' },
    comments: { kind: 'nonempty' },
    password: { kind: 'protected' },
    ...exempt,
  },
  'cite-actions': { first: { kind: 'letters' }, email: { kind: 'email' }, ...exempt },
  'recovery-groups': {
    name: { kind: 'letters' },
    units: { kind: 'number', min: 1, max: 10 },
    email: { kind: 'email' },
    from: { kind: 'nonempty' },
    to: { kind: 'nonempty' },
    ...exempt,
  },
};

export function renderFormLab(path: string): RenderedPage | null {
  if (path === '/')
    return homePage({
      header: headerComment('form-lab', FORM_LAB_PATTERN, 'G2, G8'),
      title: 'Form layouts',
      intro: 'Choose a form to complete.',
      links: FORM_LAB_PAGES.map((id) => ({ href: `/${id}`, text: id.replaceAll('-', ' ') })),
    });
  const id = path.slice(1);
  if (!FORM_LAB_ROUTES.includes(path)) return null;
  const page = layoutMatrix.find((candidate) => candidate.id === id)!;
  // Flatten the matrix's existing form, preserving all field structure.
  const body = (
    extraBodies[id] ??
    page
      ?.html()
      .replace(/^[\s\S]*?<body>/u, '')
      .replace(/<\/body>[\s\S]*$/u, '') ??
    ''
  )
    .replace(/^[\s\S]*?<body>/u, '')
    .replace(/<\/body>[\s\S]*$/u, '')
    .replace(/<\/?form[^>]*>/gu, '');
  return htmlPage(`${headerComment('form-lab', FORM_LAB_PATTERN, 'G2, G8')}
<!doctype html><html><body data-fixture-page="${id}"><form target="fixture-submit">
${body}
<input aria-label="Disabled" data-fixture-key="disabled" value="fixed" disabled>
<input aria-label="Read only" data-fixture-key="readonly" value="fixed" readonly>
<input aria-label="File" data-fixture-key="file" type="file">
<button type="button">Add another</button><button type="submit">Submit</button></form>
<iframe name="fixture-submit" hidden></iframe>${FORM_STATE_SCRIPT}</body></html>`);
}
