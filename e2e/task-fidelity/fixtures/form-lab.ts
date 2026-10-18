/** Synthetic layout forms; provenance: FEAT-055 layout matrix, plan gaps G2 and G8. */
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
] as const;
export const FORM_LAB_ROUTES = ['/', ...FORM_LAB_PAGES.map((id) => `/${id}`)];

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
  const body = page
    .html()
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
