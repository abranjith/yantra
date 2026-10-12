/**
 * `structured-listing`: the inventory exposed only through schema.org JSON-LD.
 *
 * The pattern: a page whose visible body is a thin shell with no cards, while a
 * `<script type="application/ld+json">` block carries an `ItemList` of
 * `Product` entities, each with a nested `Offer` naming its `seller`
 * `Organization`, plus color properties. An extractor that reads only visible
 * text sees no listing at all; the data is entirely in structured markup.
 */

import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  type RenderedPage,
} from './html.js';
import { INVENTORY, MAKE, MODEL, PAGE_SIZE, titleOf, type InventoryItem } from './inventory.js';

export const STRUCTURED_LISTING_PATTERN =
  'A collection whose records exist only as schema.org JSON-LD entities behind a thin visible shell.';
export const STRUCTURED_LISTING_PROVENANCE = { gaps: ['G2'] } as const;

const RESULTS_PATH = '/results';
const DETAIL_PATH = /^\/vehicle\/(itm-\d{2})$/;
const ORIGIN = 'http://structured-listing.yantra.test';

/** Every page the site serves, as `path?query`. */
export const STRUCTURED_LISTING_ROUTES: readonly string[] = Object.freeze([
  '/',
  RESULTS_PATH,
  `${RESULTS_PATH}?page=2`,
  `${RESULTS_PATH}?page=3`,
  ...INVENTORY.map((entry) => `/vehicle/${entry.id}`),
]);

/**
 * Render one `structured-listing` route, or null for an unknown path.
 *
 * @param path URL pathname.
 * @param query URL search parameters.
 */
export function renderStructuredListing(path: string, query: URLSearchParams): RenderedPage | null {
  if (path === '/') {
    return homePage({
      header: header(),
      title: `${MAKE} ${MODEL} inventory`,
      intro: 'Current inventory is published for partner applications.',
      links: [{ href: RESULTS_PATH, text: 'Inventory' }],
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

/** The items shown on a 1-based results page. */
export function structuredPageItems(page: number): readonly InventoryItem[] {
  return INVENTORY.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
}

function header(): string {
  return headerComment(
    'structured-listing',
    STRUCTURED_LISTING_PATTERN,
    `gaps ${STRUCTURED_LISTING_PROVENANCE.gaps.join(', ')}`,
  );
}

function product(entry: InventoryItem): Record<string, unknown> {
  return {
    '@type': 'Product',
    name: titleOf(entry),
    url: `${ORIGIN}/vehicle/${entry.id}`,
    sku: entry.id,
    brand: { '@type': 'Brand', name: MAKE },
    model: `${MODEL} ${entry.trim}`,
    color: entry.exteriorColor,
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'Interior color', value: entry.interiorColor },
      { '@type': 'PropertyValue', name: 'Drivetrain', value: entry.drivetrain },
      { '@type': 'PropertyValue', name: 'Condition', value: entry.condition },
    ],
    offers: {
      '@type': 'Offer',
      price: entry.price,
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
      seller: { '@type': 'Organization', name: entry.seller },
    },
  };
}

function jsonLd(value: unknown): string {
  // `<` is escaped so no string value can close the script element early.
  const json = JSON.stringify(value, null, 2).replaceAll('<', '\\u003c');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

function shell(heading: string, lines: readonly string[]): string {
  return [
    '<header><p class="brand">Inventory</p></header>',
    '<main>',
    `<h1>${escapeHtml(heading)}</h1>`,
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    '</main>',
  ].join('\n');
}

function resultsPage(query: URLSearchParams): string {
  const pageCount = Math.ceil(INVENTORY.length / PAGE_SIZE);
  const requested = Number.parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), pageCount) : 1;
  const items = structuredPageItems(page);
  const heading = `${MAKE} ${MODEL} inventory`;
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: heading,
    numberOfItems: INVENTORY.length,
    itemListElement: items.map((entry, index) => ({
      '@type': 'ListItem',
      position: (page - 1) * PAGE_SIZE + index + 1,
      item: product(entry),
    })),
  };
  const body = shell(heading, [
    `Page ${page} of ${pageCount}.`,
    'Listings on this page are published as structured data for partner applications.',
  ]);
  return htmlDocument({ header: header(), title: heading, head: jsonLd(list), body });
}

function detailPage(entry: InventoryItem): string {
  const title = titleOf(entry);
  return htmlDocument({
    header: header(),
    title,
    head: jsonLd({ '@context': 'https://schema.org', ...product(entry) }),
    body: shell(title, ['Vehicle details are published as structured data.']),
  });
}
