/**
 * `client-rendered-listing`: records injected by script after load.
 *
 * The pattern: the HTTP response is a script-rendered shell — under 10 KB, an
 * external script `src`, no `<main>` or `<article>` — and the listing cards
 * exist only after that script runs. HTTP extraction sees nothing; a browser
 * render sees every card. The script carries its data inline, rendered from
 * `inventory.ts`, so the HTML shell itself holds no truth value.
 */

import { HTML_CONTENT_TYPE, headerComment, htmlDocument, type RenderedPage } from './html.js';
import {
  INVENTORY,
  MAKE,
  MODEL,
  PAGE_SIZE,
  formatAmount,
  formatDistance,
  titleOf,
} from './inventory.js';

export const CLIENT_RENDERED_LISTING_PATTERN =
  'A collection whose records are injected into an empty shell by a script after load.';
export const CLIENT_RENDERED_LISTING_PROVENANCE = { gaps: ['G2', 'G5'] } as const;

const RESULTS_PATH = '/results';
const SCRIPT_PATH = '/assets/listing.js';

/** Every resource the site serves, as `path?query`. */
export const CLIENT_RENDERED_LISTING_ROUTES: readonly string[] = Object.freeze([
  RESULTS_PATH,
  `${RESULTS_PATH}?page=2`,
  SCRIPT_PATH,
]);

/**
 * Render one `client-rendered-listing` route, or null for an unknown path.
 *
 * @param path URL pathname.
 * @param _query URL search parameters (paging happens in the script).
 */
export function renderClientRenderedListing(
  path: string,
  _query: URLSearchParams,
): RenderedPage | null {
  if (path === RESULTS_PATH) {
    return { status: 200, contentType: HTML_CONTENT_TYPE, body: shellPage() };
  }
  if (path === SCRIPT_PATH) {
    return { status: 200, contentType: 'text/javascript; charset=utf-8', body: listingScript() };
  }
  return null;
}

function provenanceText(): string {
  return `gaps ${CLIENT_RENDERED_LISTING_PROVENANCE.gaps.join(', ')}`;
}

function shellPage(): string {
  const heading = `${MAKE} ${MODEL} listings`;
  return htmlDocument({
    header: headerComment(
      'client-rendered-listing',
      CLIENT_RENDERED_LISTING_PATTERN,
      provenanceText(),
    ),
    title: heading,
    body: [
      '<div id="app" aria-busy="true"><p>Loading listings…</p></div>',
      `<script src="${SCRIPT_PATH}"></script>`,
    ].join('\n'),
  });
}

/** Card data, one array per listing page, exactly as the script renders it. */
function pages(): readonly (readonly Record<string, string>[])[] {
  const out: Record<string, string>[][] = [];
  for (let start = 0; start < INVENTORY.length; start += PAGE_SIZE) {
    out.push(
      INVENTORY.slice(start, start + PAGE_SIZE).map((entry) => ({
        id: entry.id,
        title: titleOf(entry),
        price: formatAmount(entry.price),
        msrp: `MSRP $${formatAmount(entry.msrp)}`,
        seller: entry.seller,
        distance: `${formatDistance(entry.distanceMi)} away`,
      })),
    );
  }
  return out;
}

function listingScript(): string {
  const data = JSON.stringify(pages());
  return [
    `/* task-fidelity fixture "client-rendered-listing": ${CLIENT_RENDERED_LISTING_PATTERN} Provenance: ${provenanceText()}. */`,
    '(function () {',
    `  var pages = ${data};`,
    '  var params = new URLSearchParams(window.location.search);',
    "  var requested = parseInt(params.get('page') || '1', 10) || 1;",
    '  var page = Math.min(Math.max(requested, 1), pages.length);',
    "  var main = document.createElement('main');",
    "  var heading = document.createElement('h1');",
    `  heading.textContent = ${JSON.stringify(`${MAKE} ${MODEL} listings`)};`,
    '  main.appendChild(heading);',
    "  var list = document.createElement('ol');",
    "  list.className = 'results';",
    '  pages[page - 1].forEach(function (card) {',
    "    var item = document.createElement('li');",
    "    item.className = 'listing-card';",
    "    var title = document.createElement('h3');",
    "    var link = document.createElement('a');",
    "    link.href = '/vehicle/' + card.id;",
    '    link.textContent = card.title;',
    '    title.appendChild(link);',
    '    item.appendChild(title);',
    "    ['price', 'msrp', 'seller', 'distance'].forEach(function (key) {",
    "      var line = document.createElement('p');",
    '      line.className = key;',
    '      line.textContent = card[key];',
    '      item.appendChild(line);',
    '    });',
    '    list.appendChild(item);',
    '  });',
    '  main.appendChild(list);',
    "  var app = document.getElementById('app');",
    '  app.replaceChildren(main);',
    "  app.removeAttribute('aria-busy');",
    '})();',
    '',
  ].join('\n');
}
