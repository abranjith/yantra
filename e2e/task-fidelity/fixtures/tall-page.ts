/**
 * `tall-page`: one long, generic page with a short form at the top and a
 * labeled panel far below the fold (FEAT-058).
 *
 * The pattern: a page much taller than the viewport, so a "screenshot" can mean
 * the visible viewport, the whole scrollable page, or one element outside the
 * visible area. The standard page is about 9,000 px tall, which a full-page
 * capture covers in three tiles; the long variant is 30,000 px, which a
 * full-page capture can only cover in part, and must say so. The form's
 * password control stands for a field a stored secret would fill.
 *
 * Every block has a fixed size and the page has no margin, so the capture
 * geometry is a pure function of this file. It recreates no real page and
 * names no site.
 */

import {
  escapeHtml,
  headerComment,
  homePage,
  htmlDocument,
  htmlPage,
  type RenderedPage,
} from './html.js';

export const TALL_PAGE_PATTERN =
  'A page far taller than the viewport, with a short form at the top and a labeled panel below the fold.';
export const TALL_PAGE_PROVENANCE = { run: '20261014T023539Z', gaps: ['G7', 'G8'] } as const;

/** The standard tall page (about 9,000 px). */
export const TALL_PAGE_PATH = '/report';

/** The long variant (30,000 px): more than six 4,096 px tiles. */
export const TALL_PAGE_LONG_PATH = '/report/long';

/** CSS pixel heights of the two pages. */
export const TALL_PAGE_HEIGHT = 9_000;
export const TALL_PAGE_LONG_HEIGHT = 30_000;

/** The labeled panel's top edge and size, in CSS pixels. */
export const TALL_PAGE_PANEL = { top: 6_000, width: 320, height: 180 } as const;

/** The panel's accessible name. */
export const TALL_PAGE_PANEL_NAME = 'Feature panel';

/** The form's text field and its password field. */
export const TALL_PAGE_NAME_FIELD = 'Your name';
export const TALL_PAGE_SECRET_FIELD = 'Account password';

export const TALL_PAGE_ROUTES: readonly string[] = Object.freeze([
  '/',
  TALL_PAGE_PATH,
  TALL_PAGE_LONG_PATH,
]);

/** Render one route, or null for an unknown path. */
export function renderTallPage(path: string, _query: URLSearchParams): RenderedPage | null {
  if (path === TALL_PAGE_PATH) return htmlPage(tallPage('Quarterly report', TALL_PAGE_HEIGHT));
  if (path === TALL_PAGE_LONG_PATH) {
    return htmlPage(tallPage('Annual report', TALL_PAGE_LONG_HEIGHT));
  }
  if (path === '/') {
    return homePage({
      header: header(),
      title: 'Reports',
      intro: 'Long reports with a short form at the top.',
      links: [
        { href: TALL_PAGE_PATH, text: 'Quarterly report' },
        { href: TALL_PAGE_LONG_PATH, text: 'Annual report' },
      ],
    });
  }
  return null;
}

function header(): string {
  return headerComment(
    'tall-page',
    TALL_PAGE_PATTERN,
    `run ${TALL_PAGE_PROVENANCE.run}, gaps ${TALL_PAGE_PROVENANCE.gaps.join(', ')}`,
  );
}

function tallPage(title: string, height: number): string {
  const panel = TALL_PAGE_PANEL;
  return htmlDocument({
    header: header(),
    title,
    head: '<style>html,body{margin:0;padding:0}</style>',
    body: [
      `<main style="position:relative;width:1000px;height:${height}px;background:#f4f6fb">`,
      `<h1 style="margin:0;padding:16px 24px;font:24px sans-serif">${escapeHtml(title)}</h1>`,
      '<form style="padding:0 24px" onsubmit="event.preventDefault()">',
      `<label>${escapeHtml(TALL_PAGE_NAME_FIELD)} <input name="name" type="text"></label>`,
      `<label>${escapeHtml(TALL_PAGE_SECRET_FIELD)} <input name="password" type="password" autocomplete="current-password"></label>`,
      '<button type="button">Save draft</button>',
      '</form>',
      `<button type="button" style="position:absolute;left:40px;top:${panel.top}px;` +
        `width:${panel.width}px;height:${panel.height}px;border:0;background:#2e7d32;color:#fff">` +
        `${escapeHtml(TALL_PAGE_PANEL_NAME)}</button>`,
      '</main>',
    ].join('\n'),
  });
}
