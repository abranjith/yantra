/**
 * `challenge-interstitial`: an HTTP 200 human-verification page in place of the
 * requested content.
 *
 * The pattern: a 200 response whose body is a CAPTCHA-widget form ("verify you
 * are human", a widget container carrying a site-key attribute, a hidden token
 * input) and no listing data at all. The markers are the standard, cross-site
 * challenge-widget ones FEAT-050's documented marker list names: a
 * `data-sitekey` attribute and a `captcha` token on a class, id, and name inside
 * a `<form>`. They are widget vocabulary, like ARIA roles — no vendor, host, or
 * brand appears.
 *
 * Two variants measure today's accidental size heuristic (G10) rather than rely
 * on it:
 *
 * - `small`: under 10 KB with a script `src` and no semantic root, which the
 *   hybrid fetcher happens to escalate to a browser render.
 * - `large-main`: the same widget wrapped in `<main>` and padded past 10 KB with
 *   boilerplate, which the hybrid fetcher does not escalate.
 */

import { HTML_CONTENT_TYPE, headerComment, htmlDocument, type RenderedPage } from './html.js';

export const CHALLENGE_INTERSTITIAL_PATTERN =
  'A 200 response that serves a human-verification widget form instead of the requested content.';
export const CHALLENGE_INTERSTITIAL_PROVENANCE = {
  run: '20260925T130634Z',
  gaps: ['G10'],
} as const;

/** The two challenge variants, by request path. */
export const CHALLENGE_PATHS = {
  small: '/small/results',
  'large-main': '/large-main/results',
} as const;

const WIDGET_SCRIPT_PATH = '/challenge/widget.js';

/** The size threshold today's escalation heuristic keys on. */
export const ESCALATION_SIZE_BYTES = 10_000;

/** Every resource the site serves, as `path?query`. */
export const CHALLENGE_INTERSTITIAL_ROUTES: readonly string[] = Object.freeze([
  '/',
  CHALLENGE_PATHS.small,
  CHALLENGE_PATHS['large-main'],
  WIDGET_SCRIPT_PATH,
]);

/**
 * Render one `challenge-interstitial` route. Like a real bot wall, the site
 * challenges every page: the small variant at its own path, and the
 * `large-main` variant everywhere else.
 *
 * @param path URL pathname.
 * @param _query URL search parameters (unused: every query gets the challenge).
 */
export function renderChallengeInterstitial(
  path: string,
  _query: URLSearchParams,
): RenderedPage | null {
  if (path === CHALLENGE_PATHS.small) return html(smallVariant());
  if (path === WIDGET_SCRIPT_PATH) {
    return {
      status: 200,
      contentType: 'text/javascript; charset=utf-8',
      body:
        `/* task-fidelity fixture "challenge-interstitial": ${CHALLENGE_INTERSTITIAL_PATTERN} Provenance: ${provenanceText()}. */\n` +
        "document.documentElement.setAttribute('data-challenge-ready', 'true');\n",
    };
  }
  return html(largeMainVariant());
}

function html(body: string): RenderedPage {
  return { status: 200, contentType: HTML_CONTENT_TYPE, body };
}

function provenanceText(): string {
  return `run ${CHALLENGE_INTERSTITIAL_PROVENANCE.run}; gaps ${CHALLENGE_INTERSTITIAL_PROVENANCE.gaps.join(', ')}`;
}

function header(): string {
  return headerComment('challenge-interstitial', CHALLENGE_INTERSTITIAL_PATTERN, provenanceText());
}

function widgetForm(): string {
  return [
    '<form id="captcha-form" class="challenge-form" action="/verify" method="post">',
    '<h1>Please verify you are human</h1>',
    '<p>The site is currently unavailable to automated requests. Complete the check below to continue.</p>',
    '<div id="captcha-widget" class="captcha-widget" data-sitekey="fixture-site-key-0001"></div>',
    '<input type="hidden" name="captcha-token" value="">',
    '<button type="submit">Continue</button>',
    '</form>',
  ].join('\n');
}

function smallVariant(): string {
  return htmlDocument({
    header: header(),
    title: 'Verification required',
    head: `<script src="${WIDGET_SCRIPT_PATH}" async></script>`,
    body: widgetForm(),
  });
}

/** Generic interstitial boilerplate, repeated only to cross the size threshold. */
const BOILERPLATE = [
  'This verification step helps keep the service available for everyone. Automated traffic can ' +
    'slow the service down for people who are trying to use it, so some requests are asked to ' +
    'confirm that a person is present before the page loads.',
  'If you are seeing this page repeatedly, check that your browser accepts cookies and runs ' +
    'scripts, then try again. Privacy extensions and shared network connections can sometimes ' +
    'trigger additional checks. The check does not store the answers you provide.',
  'Requests that cannot complete the check are not served the requested page. If you believe ' +
    'you reached this page in error, wait a few minutes before trying again, or contact support ' +
    'with the reference shown at the bottom of this page.',
];

function largeMainVariant(): string {
  const paragraphs: string[] = [];
  let index = 0;
  // Pad deterministically until the page is safely past the escalation
  // threshold, so the variant measures the heuristic rather than grazing it.
  while (paragraphs.join('\n').length < ESCALATION_SIZE_BYTES + 2_000) {
    paragraphs.push(`<p>${BOILERPLATE[index % BOILERPLATE.length] ?? ''}</p>`);
    index += 1;
  }
  return htmlDocument({
    header: header(),
    title: 'Verification required',
    body: [
      '<main>',
      widgetForm(),
      '<section class="help">',
      '<h2>Why am I seeing this?</h2>',
      ...paragraphs,
      '<p class="reference">Reference: fixture-check-0001</p>',
      '</section>',
      '</main>',
    ].join('\n'),
  });
}
