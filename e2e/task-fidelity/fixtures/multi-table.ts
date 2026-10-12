/**
 * `multi-table`: a page whose first table is an unrelated summary and whose
 * second table holds the answer.
 *
 * The pattern: a specification page with more than one `<table>`. An extractor
 * that reads only the first table (TODO line 214) returns the summary and
 * misses the answer entirely.
 */

import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  type RenderedPage,
} from './html.js';
import { MAKE, MODEL } from './inventory.js';

export const MULTI_TABLE_PATTERN =
  'A specification page with several tables where the answer sits in a table after the first.';
export const MULTI_TABLE_PROVENANCE = { gaps: ['G2'] } as const;

/** The page's path. */
export const MULTI_TABLE_PATH = '/specifications';

/** Every page the site serves, as `path?query`. */
export const MULTI_TABLE_ROUTES: readonly string[] = Object.freeze(['/', MULTI_TABLE_PATH]);

/** The first table: unrelated to any question a scenario asks. */
const SUMMARY_TABLE = {
  caption: 'Showroom hours',
  headers: ['Day', 'Opens', 'Closes'],
  rows: [
    ['Monday to Friday', '9:00', '19:00'],
    ['Saturday', '9:00', '17:00'],
    ['Sunday', 'Closed', 'Closed'],
  ],
} as const;

/** The second table: the one that answers the question. */
const ANSWER_TABLE = {
  caption: 'Towing and payload by trim',
  headers: ['Trim', 'Drivetrain', 'Towing capacity', 'Payload'],
  rows: [
    ['Base', 'FWD', '1,500 lb', '1,180 lb'],
    ['Base', 'AWD', '2,000 lb', '1,150 lb'],
    ['Ridge', 'AWD', '3,500 lb', '1,320 lb'],
    ['Summit', 'FWD', '3,000 lb', '1,290 lb'],
    ['Summit', 'AWD', '4,500 lb', '1,410 lb'],
  ],
} as const;

/** The scored answer: the `Summit AWD` towing capacity, in table index 1. */
export const MULTI_TABLE_ANSWER = Object.freeze({
  tableIndex: 1,
  trim: 'Summit',
  drivetrain: 'AWD',
  cell: '4,500 lb',
});

/**
 * Render one `multi-table` route, or null for an unknown path.
 *
 * @param path URL pathname.
 * @param _query URL search parameters (unused).
 */
export function renderMultiTable(path: string, _query: URLSearchParams): RenderedPage | null {
  if (path === MULTI_TABLE_PATH) return htmlPage(specificationPage());
  if (path === '/') {
    return homePage({
      header: header(),
      title: `${MAKE} ${MODEL}`,
      intro: 'Trims, capability, and showroom information.',
      links: [{ href: MULTI_TABLE_PATH, text: 'Specifications' }],
    });
  }
  return null;
}

function header(): string {
  return headerComment(
    'multi-table',
    MULTI_TABLE_PATTERN,
    `gaps ${MULTI_TABLE_PROVENANCE.gaps.join(', ')}`,
  );
}

function table(input: {
  readonly caption: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): string {
  return [
    '<table>',
    `<caption>${escapeHtml(input.caption)}</caption>`,
    `<thead><tr>${input.headers.map((cell) => `<th scope="col">${escapeHtml(cell)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
    ...input.rows.map(
      (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`,
    ),
    '</tbody>',
    '</table>',
  ].join('\n');
}

function specificationPage(): string {
  const heading = `${MAKE} ${MODEL} specifications`;
  return htmlDocument({
    header: headerComment(
      'multi-table',
      MULTI_TABLE_PATTERN,
      `gaps ${MULTI_TABLE_PROVENANCE.gaps.join(', ')}`,
    ),
    title: heading,
    body: [
      '<main>',
      `<h1>${escapeHtml(heading)}</h1>`,
      '<p>Visit the showroom to see every trim. Opening hours are listed below.</p>',
      table(SUMMARY_TABLE),
      '<h2>Capability</h2>',
      '<p>Ratings apply to properly equipped vehicles and assume a single driver.</p>',
      table(ANSWER_TABLE),
      '</main>',
    ].join('\n'),
  });
}
