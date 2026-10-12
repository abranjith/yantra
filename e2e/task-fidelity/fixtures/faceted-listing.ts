/**
 * `faceted-listing`: a server-rendered collection with facets, pagination, and
 * detail pages.
 *
 * The pattern: repeated cards (title link, plain-text price block, seller link,
 * distance, detail link), a facet sidebar whose entries are short labels with
 * parenthesized counts linking to variants of the current URL, pagination
 * links, and per-item detail pages whose attributes live in a `<dl>`. Colors
 * appear only on detail pages, so a complete answer requires following detail
 * links. Every value renders from `inventory.ts`.
 *
 * The first card is the G2 regression card: its price is plain text while its
 * title and seller are links — the card shape an article extractor reduced to
 * a bare price block.
 */

import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  slugOf,
  type RenderedPage,
} from './html.js';
import {
  INVENTORY,
  MAKE,
  MODEL,
  PAGE_SIZE,
  formatAmount,
  formatDistance,
  titleOf,
  type InventoryItem,
} from './inventory.js';

export const FACETED_LISTING_PATTERN =
  'A server-rendered collection of repeated cards with facet links, pagination links, and detail pages holding the attributes the cards omit.';
export const FACETED_LISTING_PROVENANCE = { run: '20260925T130634Z', gaps: ['G2', 'G3'] } as const;

/** The listing filters the facet sidebar exposes, in sidebar order. */
const FACETS = [
  { param: 'condition', label: 'Condition', values: ['new', 'used'] },
  { param: 'drivetrain', label: 'Drivetrain', values: ['AWD', 'FWD'] },
  { param: 'trim', label: 'Trim', values: ['Base', 'Ridge', 'Summit'] },
] as const;

type FacetParam = (typeof FACETS)[number]['param'];

const RESULTS_PATH = '/new/results';
const DETAIL_PATH = /^\/vehicle\/(itm-\d{2})$/;

/** Every page the site serves, as `path?query`: each listing page and each detail page. */
export const FACETED_LISTING_ROUTES: readonly string[] = Object.freeze([
  '/',
  RESULTS_PATH,
  `${RESULTS_PATH}?page=2`,
  `${RESULTS_PATH}?page=3`,
  `${RESULTS_PATH}?drivetrain=AWD`,
  `${RESULTS_PATH}?drivetrain=AWD&page=2`,
  `${RESULTS_PATH}?drivetrain=FWD`,
  `${RESULTS_PATH}?condition=used`,
  `${RESULTS_PATH}?trim=Summit&drivetrain=AWD`,
  ...INVENTORY.map((entry) => `/vehicle/${entry.id}`),
]);

/**
 * Render one `faceted-listing` route, or null for an unknown path.
 *
 * @param path URL pathname.
 * @param query URL search parameters.
 */
export function renderFacetedListing(path: string, query: URLSearchParams): RenderedPage | null {
  if (path === '/') {
    return homePage({
      header: header(),
      title: `${MAKE} ${MODEL} dealers`,
      intro: 'Browse new and used listings from participating sellers.',
      links: [
        { href: RESULTS_PATH, text: 'Shop new' },
        { href: `${RESULTS_PATH}?condition=used`, text: 'Shop used' },
      ],
    });
  }
  if (path === RESULTS_PATH) return htmlPage(resultsPage(query));
  const detail = DETAIL_PATH.exec(path);
  if (detail !== null) {
    const entry = INVENTORY.find((candidate) => candidate.id === detail[1]);
    return entry === undefined ? null : htmlPage(detailPage(entry));
  }
  return null;
}

function header(): string {
  return headerComment(
    'faceted-listing',
    FACETED_LISTING_PATTERN,
    `run ${FACETED_LISTING_PROVENANCE.run}; gaps ${FACETED_LISTING_PROVENANCE.gaps.join(', ')}`,
  );
}

function siteHeader(): string {
  return [
    '<header>',
    '<nav aria-label="Site">',
    `<a href="${RESULTS_PATH}">Shop new</a>`,
    `<a href="${RESULTS_PATH}?condition=used">Shop used</a>`,
    '</nav>',
    '</header>',
  ].join('\n');
}

function siteFooter(): string {
  return '<footer><p>Listings are provided by participating sellers. Prices exclude taxes and registration.</p></footer>';
}

function activeFilters(query: URLSearchParams): Partial<Record<FacetParam, string>> {
  const filters: Partial<Record<FacetParam, string>> = {};
  for (const facet of FACETS) {
    const value = query.get(facet.param);
    if (value !== null && value.length > 0) filters[facet.param] = value;
  }
  return filters;
}

function matches(entry: InventoryItem, filters: Partial<Record<FacetParam, string>>): boolean {
  return (Object.entries(filters) as [FacetParam, string][]).every(
    ([param, value]) => String(entry[param]).toLowerCase() === value.toLowerCase(),
  );
}

/** A results URL with `filters` applied, plus an optional page number. */
function resultsHref(filters: Partial<Record<FacetParam, string>>, page = 1): string {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    const value = filters[facet.param];
    if (value !== undefined) params.set(facet.param, value);
  }
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return search.length === 0 ? RESULTS_PATH : `${RESULTS_PATH}?${search}`;
}

function resultsPage(query: URLSearchParams): string {
  const filters = activeFilters(query);
  const matching = INVENTORY.filter((entry) => matches(entry, filters));
  const pageCount = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
  const requested = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1;
  const shown = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const heading = `${MAKE} ${MODEL} for sale near you`;

  const body = [
    siteHeader(),
    '<div class="layout">',
    facetSidebar(filters),
    '<main>',
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p class="result-count">${matching.length} results · page ${page} of ${pageCount}</p>`,
    '<ol class="results">',
    ...shown.map(card),
    '</ol>',
    pagination(filters, page, pageCount),
    '</main>',
    '</div>',
    siteFooter(),
  ].join('\n');
  return htmlDocument({ header: header(), title: heading, body });
}

function facetSidebar(filters: Partial<Record<FacetParam, string>>): string {
  const groups = FACETS.map((facet) => {
    // A facet counts items that match every OTHER active filter, as a
    // refinement sidebar does: the count is what following the link yields.
    const others = { ...filters };
    delete others[facet.param];
    const entries = facet.values.map((value) => {
      const count = INVENTORY.filter(
        (entry) => matches(entry, others) && String(entry[facet.param]) === value,
      ).length;
      const label = facet.param === 'condition' ? capitalize(value) : value;
      return `<li><a href="${escapeHtml(resultsHref({ ...others, [facet.param]: value }))}">${escapeHtml(label)} (${count})</a></li>`;
    });
    return [`<h2>${facet.label}</h2>`, '<ul>', ...entries, '</ul>'].join('\n');
  });
  return ['<aside class="filters" aria-label="Refine results">', ...groups, '</aside>'].join('\n');
}

function card(entry: InventoryItem): string {
  const title = titleOf(entry);
  const detail = `/vehicle/${entry.id}`;
  return [
    `<li class="listing-card">`,
    `<h3><a href="${detail}">${escapeHtml(title)}</a></h3>`,
    '<div class="price-block">',
    `<span class="price">${formatAmount(entry.price)}</span>`,
    `<span class="msrp">MSRP $${formatAmount(entry.msrp)}</span>`,
    '<span class="fees">Fees included</span>',
    '</div>',
    `<p class="seller"><a href="/dealer/${slugOf(entry.seller)}">${escapeHtml(entry.seller)}</a></p>`,
    `<p class="distance">${formatDistance(entry.distanceMi)} away</p>`,
    `<a class="detail-link" href="${detail}">View details</a>`,
    '</li>',
  ].join('\n');
}

function pagination(
  filters: Partial<Record<FacetParam, string>>,
  page: number,
  pageCount: number,
): string {
  if (pageCount <= 1) return '';
  const links: string[] = [];
  if (page > 1)
    links.push(`<a rel="prev" href="${escapeHtml(resultsHref(filters, page - 1))}">Previous</a>`);
  for (let number = 1; number <= pageCount; number += 1) {
    links.push(
      number === page
        ? `<span aria-current="page">${number}</span>`
        : `<a href="${escapeHtml(resultsHref(filters, number))}">${number}</a>`,
    );
  }
  if (page < pageCount)
    links.push(`<a rel="next" href="${escapeHtml(resultsHref(filters, page + 1))}">Next</a>`);
  return ['<nav class="pagination" aria-label="Pagination">', ...links, '</nav>'].join('\n');
}

function detailPage(entry: InventoryItem): string {
  const title = titleOf(entry);
  const stock = `NV26-${entry.id.slice(-2).padStart(4, '0')}`;
  const attributes: readonly [string, string][] = [
    ['Exterior color', entry.exteriorColor],
    ['Interior color', entry.interiorColor],
    ['Drivetrain', entry.drivetrain],
    ['Condition', capitalize(entry.condition)],
    ['Year', String(entry.year)],
    ['Trim', entry.trim],
    ['MSRP', `$${formatAmount(entry.msrp)}`],
    ['Stock number', stock],
  ];
  const body = [
    siteHeader(),
    '<main>',
    '<article>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="price">$${formatAmount(entry.price)}</p>`,
    `<p class="offered-by">Offered by <a href="/dealer/${slugOf(entry.seller)}">${escapeHtml(entry.seller)}</a>, ${formatDistance(entry.distanceMi)} away.</p>`,
    '<h2>Vehicle details</h2>',
    '<dl class="attributes">',
    ...attributes.map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`),
    '</dl>',
    '<h2>About this vehicle</h2>',
    `<p>This ${escapeHtml(title)} is listed by ${escapeHtml(entry.seller)}. The listed price includes ` +
      'dealer fees; taxes, title, and registration are additional. Availability is confirmed by the ' +
      'seller at the time of purchase, and the seller may update the listing without notice.</p>',
    '<p>Every vehicle on this page is shown with the attributes the seller reported. Contact the ' +
      'seller to confirm equipment, colors, and drivetrain before visiting, and ask for the ' +
      'stock number above so the seller can locate the vehicle quickly.</p>',
    '</article>',
    '</main>',
    siteFooter(),
  ].join('\n');
  return htmlDocument({ header: header(), title, body });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}
