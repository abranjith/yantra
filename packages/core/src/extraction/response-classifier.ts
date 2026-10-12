/**
 * Classify a fetched response before anything extracts it (FEAT-050, G10).
 *
 * A plain GET in run `20260925T130634Z` returned HTTP 200 with a 3.7 KB
 * CAPTCHA interstitial. It reached a browser only because a size heuristic
 * happened to fire; the same page wrapped in `<main>`, or padded past 10 KB,
 * would have been extracted as content and published as a source. Memory's
 * "honor bot detection; hand off" rule was enforced by accident. This module
 * makes it a decision: every response is `challenge`, `js-shell`, or
 * `content`, and only `content` is ever extracted.
 *
 * Cost: one lowercase scan of HTML already in hand. The DOM is parsed only
 * when that scan finds a marker token (memory → diagnostic work is paid only
 * on the path that needs it; the spec asserts it with a parser spy).
 */

import { load, type CheerioAPI } from 'cheerio';

import type { FetchedDoc } from './types.js';

/**
 * The documented challenge markers.
 *
 * Memory forbids website-specific logic, and this list is not a site list:
 * every entry is a standard, cross-site **challenge-widget** component — the
 * attribute or class a human-verification widget renders with, or the phrase
 * its interstitial shows — in the same category as ARIA roles. No host, URL,
 * or brand-specific selector appears, and none may be added. The FEAT-049
 * site-token lint list (`SITE_TOKEN_SOURCE` in `eslint.config.js`) must stay
 * clean against these values.
 *
 * Each marker has a stable ID, reported in `FetchError.context.marker`, the
 * `fetch_challenge` audit line, and run notices.
 */
export const CHALLENGE_MARKERS = Object.freeze({
  /** Widget attributes and classes, matched in the markup. */
  widgets: Object.freeze([
    { id: 'data-sitekey', token: 'data-sitekey' },
    { id: 'g-recaptcha', token: 'g-recaptcha' },
    { id: 'h-captcha', token: 'h-captcha' },
    { id: 'cf-turnstile', token: 'cf-turnstile' },
  ] as const),
  /** A `captcha` token on an `id`, `class`, or `name` inside (or on) a `<form>`. */
  formCaptcha: Object.freeze({ id: 'form-captcha', token: 'captcha' } as const),
  /** Interstitial phrases, matched in `<title>` or the first `<h1>`. */
  phrases: Object.freeze([
    { id: 'verify-you-are-human', phrase: 'verify you are human' },
    { id: 'are-you-a-robot', phrase: 'are you a robot' },
    { id: 'unusual-traffic', phrase: 'unusual traffic' },
    { id: 'checking-your-browser', phrase: 'checking your browser' },
    { id: 'press-and-hold', phrase: 'press and hold' },
    { id: 'complete-the-security-check', phrase: 'complete the security check' },
  ] as const),
});

/** A documented marker ID (closed). */
export type ChallengeMarker =
  | (typeof CHALLENGE_MARKERS.widgets)[number]['id']
  | typeof CHALLENGE_MARKERS.formCaptcha.id
  | (typeof CHALLENGE_MARKERS.phrases)[number]['id'];

/** What a response is, decided before extraction. */
export type ResponseClass =
  | { readonly kind: 'challenge'; readonly marker: ChallengeMarker }
  | { readonly kind: 'js-shell' }
  | { readonly kind: 'content' };

/** A widget on a page with less visible text than this is an interstitial. */
export const WIDGET_TEXT_LIMIT = 1_500;
/** A challenge phrase heading a page with less visible text than this is one. */
export const PHRASE_TEXT_LIMIT = 3_000;
/** A script-only HTML response under this size is a client-rendered shell. */
export const JS_SHELL_SIZE_LIMIT = 10_000;

/** Every token the cheap pass looks for; a hit is what earns a DOM parse. */
const SCAN_TOKENS: readonly string[] = [
  ...CHALLENGE_MARKERS.widgets.map((marker) => marker.token),
  CHALLENGE_MARKERS.formCaptcha.token,
  ...CHALLENGE_MARKERS.phrases.map((marker) => marker.phrase),
];

/**
 * Classify one fetched response. Pure: reads only the HTML already in hand.
 *
 * A response is a `challenge` when any of these holds:
 *
 * 1. a widget marker is present **and** the visible text is under
 *    {@link WIDGET_TEXT_LIMIT} characters;
 * 2. a challenge phrase is in `<title>` or the first `<h1>` **and** the
 *    visible text is under {@link PHRASE_TEXT_LIMIT} characters;
 * 3. a challenge phrase is in `<title>` or the first `<h1>` **and** a widget
 *    marker is present, at any size.
 *
 * The size limits keep a long article with an embedded comment-form CAPTCHA
 * (rule 1 alone) or an article *about* CAPTCHAs (rule 2 alone) from becoming a
 * challenge. Rule 3 needs both independent signals at once — the page's own
 * heading names the check and the widget is on the page — which is what an
 * interstitial padded with help text looks like (`challenge-large-main`).
 *
 * Otherwise an HTML response under {@link JS_SHELL_SIZE_LIMIT} with a script
 * `src` and no `<article>`/`<main>` is a `js-shell` (the pre-FEAT-050
 * escalation rule, moved here verbatim), and everything else is `content`.
 *
 * @param doc The fetched response.
 * @param parse The DOM parser; injectable so tests can count parses.
 */
export function classifyResponse(
  doc: Pick<FetchedDoc, 'html' | 'contentType'>,
  parse: (html: string) => CheerioAPI = load,
): ResponseClass {
  const contentType = (doc.contentType ?? '').toLowerCase();
  if (contentType.length > 0 && !contentType.includes('html')) return { kind: 'content' };

  const lower = doc.html.toLowerCase();
  if (SCAN_TOKENS.some((token) => lower.includes(token))) {
    const challenge = confirmChallenge(parse(doc.html));
    if (challenge !== null) return { kind: 'challenge', marker: challenge };
  }

  if (isJsShell(contentType, doc.html, lower)) return { kind: 'js-shell' };
  return { kind: 'content' };
}

/** The confirm pass: one parse, then the three rules. */
function confirmChallenge($: CheerioAPI): ChallengeMarker | null {
  const heading = `${$('title').first().text()} ${$('h1').first().text()}`
    .toLowerCase()
    .replace(/\s+/gu, ' ');
  const phrase = CHALLENGE_MARKERS.phrases.find((marker) => heading.includes(marker.phrase));
  const widget = widgetMarker($);
  if (widget === null && phrase === undefined) return null;

  const visible = visibleTextLength($);
  if (widget !== null && visible < WIDGET_TEXT_LIMIT) return widget;
  if (phrase !== undefined && visible < PHRASE_TEXT_LIMIT) return phrase.id;
  if (phrase !== undefined && widget !== null) return phrase.id;
  return null;
}

/** The first widget marker present, in documented order, or null. */
function widgetMarker($: CheerioAPI): ChallengeMarker | null {
  for (const marker of CHALLENGE_MARKERS.widgets) {
    if (marker.token.startsWith('data-')) {
      if ($(`[${marker.token}]`).length > 0) return marker.id;
    } else if ($(`.${marker.token}, #${marker.token}`).length > 0) {
      return marker.id;
    }
  }
  const formCaptcha = $('form')
    .toArray()
    .some((form) =>
      [form, ...$(form).find('[id], [class], [name]').toArray()].some((element) =>
        ['id', 'class', 'name'].some((attribute) => hasCaptchaToken($(element).attr(attribute))),
      ),
    );
  return formCaptcha ? CHALLENGE_MARKERS.formCaptcha.id : null;
}

/** True when an attribute value has a token (split on non-alphanumerics) naming a captcha. */
function hasCaptchaToken(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((token) => token.includes(CHALLENGE_MARKERS.formCaptcha.token));
}

/** Visible text length: everything but `script`, `style`, and `noscript`, whitespace-collapsed. */
function visibleTextLength($: CheerioAPI): number {
  $('script, style, noscript, template').remove();
  const text = $('body').length > 0 ? $('body').text() : $.root().text();
  return text.replace(/\s+/gu, ' ').trim().length;
}

function isJsShell(contentType: string, html: string, lower: string): boolean {
  if (!contentType.includes('text/html')) return false;
  if (html.length >= JS_SHELL_SIZE_LIMIT) return false;
  const hasScriptSrc = lower.includes('<script') && lower.includes('src=');
  const hasSemanticRoot = lower.includes('<article') || lower.includes('<main');
  return hasScriptSrc && !hasSemanticRoot;
}
