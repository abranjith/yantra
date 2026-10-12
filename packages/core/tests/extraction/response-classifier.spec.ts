import { load } from 'cheerio';
import { describe, expect, it, vi } from 'vitest';

import {
  CHALLENGE_MARKERS,
  classifyResponse,
  type ResponseClass,
} from '../../src/extraction/response-classifier.js';

/**
 * Every fixture here is a nameable generic pattern — an interstitial, an
 * article, a script shell — built from widget vocabulary. None carries a real
 * site's markup, host, or brand.
 */

const HTML = 'text/html; charset=utf-8';

function page(body: string, options: { title?: string; head?: string } = {}): string {
  return (
    `<!doctype html><html><head><title>${options.title ?? 'Page'}</title>${options.head ?? ''}` +
    `</head><body>${body}</body></html>`
  );
}

function classify(html: string, contentType: string | null = HTML): ResponseClass {
  return classifyResponse({ html, contentType });
}

/** The small human-verification interstitial: a widget form and little else. */
const SMALL_INTERSTITIAL = page(
  '<form id="verify-form" action="/verify" method="post">' +
    '<h1>One more step</h1>' +
    '<div class="widget" data-sitekey="fixture-key-0001"></div>' +
    '<button type="submit">Continue</button></form>',
  { title: 'Just a moment', head: '<script src="/widget.js" async></script>' },
);

/** Help text a padded interstitial repeats to push past the old size heuristic. */
const HELP =
  'This verification step helps keep the service available for everyone. Requests that ' +
  'cannot complete the check are not served the requested page. If you see this page ' +
  'repeatedly, check that your browser accepts cookies and runs scripts, then try again. ';

/** The same interstitial wrapped in `<main>` and padded past 10 KB of visible text. */
const LARGE_MAIN_INTERSTITIAL = page(
  '<main><form id="captcha-form" action="/verify" method="post">' +
    '<h1>Please verify you are human</h1>' +
    '<div id="captcha-widget" class="captcha-widget" data-sitekey="fixture-key-0001"></div>' +
    '<input type="hidden" name="captcha-token" value="">' +
    '<button type="submit">Continue</button></form>' +
    `<section><h2>Why am I seeing this?</h2>${`<p>${HELP}</p>`.repeat(60)}</section></main>`,
  { title: 'Verification required' },
);

/** A phrase-only interstitial: no widget, just the browser-check message. */
const PHRASE_INTERSTITIAL = page(
  '<h1>Checking your browser before accessing this page</h1>' +
    '<p>This process is automatic. Your browser will redirect shortly.</p>',
  { title: 'Please wait' },
);

const SENTENCE =
  'The committee met on Tuesday to review the quarterly report, and members discussed the ' +
  'budget, the hiring plan, and the timeline for the new community center in some detail. ';

/** A ~4,000-word article whose comment form embeds a widget. */
const ARTICLE_WITH_COMMENT_WIDGET = page(
  '<main><article><h1>Quarterly committee report</h1>' +
    `${`<p>${SENTENCE}</p>`.repeat(140)}</article>` +
    '<section class="comments"><h2>Leave a comment</h2>' +
    '<form id="comment-form" action="/comment" method="post"><textarea name="body"></textarea>' +
    '<div class="g-recaptcha" data-sitekey="fixture-key-0002"></div>' +
    '<button>Post</button></form></section></main>',
  { title: 'Quarterly committee report' },
);

const PLAIN_ARTICLE = page(
  `<main><article><h1>Field notes</h1>${`<p>${SENTENCE}</p>`.repeat(20)}</article></main>`,
  { title: 'Field notes' },
);

const SCRIPT_SHELL = page('<div id="root"></div>', {
  title: 'App',
  head: '<script src="/bundle.js" defer></script>',
});

describe('@no-llm extraction/response-classifier', () => {
  it('classifies a small widget interstitial as a challenge', () => {
    expect(classify(SMALL_INTERSTITIAL)).toEqual({ kind: 'challenge', marker: 'data-sitekey' });
  });

  it('classifies the same interstitial in <main> and past 10 KB as a challenge (G10)', () => {
    expect(LARGE_MAIN_INTERSTITIAL.length).toBeGreaterThan(10_000);

    expect(classify(LARGE_MAIN_INTERSTITIAL)).toEqual({
      kind: 'challenge',
      marker: 'verify-you-are-human',
    });
  });

  it('classifies a phrase-only interstitial as a challenge', () => {
    expect(classify(PHRASE_INTERSTITIAL)).toEqual({
      kind: 'challenge',
      marker: 'checking-your-browser',
    });
  });

  it('keeps a long article with a comment-form widget as content', () => {
    expect(ARTICLE_WITH_COMMENT_WIDGET.split(/\s+/u).length).toBeGreaterThan(3_500);

    expect(classify(ARTICLE_WITH_COMMENT_WIDGET)).toEqual({ kind: 'content' });
  });

  it('keeps a long article ABOUT verification checks as content (phrase without widget)', () => {
    const about = page(
      `<article><h1>Are you a robot? A short history of checks</h1>${`<p>${SENTENCE}</p>`.repeat(30)}</article>`,
      { title: 'Are you a robot? A short history of checks' },
    );

    expect(classify(about)).toEqual({ kind: 'content' });
  });

  it('classifies a script-only shell as js-shell', () => {
    expect(classify(SCRIPT_SHELL)).toEqual({ kind: 'js-shell' });
  });

  it('classifies a plain article as content', () => {
    expect(classify(PLAIN_ARTICLE)).toEqual({ kind: 'content' });
  });

  it('recognizes a captcha token on a form control as the form-captcha marker', () => {
    const html = page(
      '<form action="/go"><label>Code</label><input name="captcha_answer"><button>Go</button></form>',
    );

    expect(classify(html)).toEqual({ kind: 'challenge', marker: 'form-captcha' });
  });

  it('does not treat the word "captcha" in prose as a widget', () => {
    const html = page(
      `<article><h1>Accessibility notes</h1><p>Some sites use a captcha.</p>${`<p>${SENTENCE}</p>`.repeat(3)}</article>`,
    );

    expect(classify(html).kind).not.toBe('challenge');
  });

  it.each(CHALLENGE_MARKERS.widgets.filter((marker) => !marker.token.startsWith('data-')))(
    'recognizes the $id widget class on a small page',
    (marker) => {
      const html = page(`<div class="${marker.token}"></div><p>Continue below.</p>`);

      expect(classify(html)).toEqual({ kind: 'challenge', marker: marker.id });
    },
  );

  it.each(CHALLENGE_MARKERS.phrases)(
    'recognizes the "$phrase" heading on a small page',
    (marker) => {
      const html = page(`<h1>Please, ${marker.phrase.toUpperCase()}</h1><p>One moment.</p>`);

      expect(classify(html)).toEqual({ kind: 'challenge', marker: marker.id });
    },
  );

  it('treats non-HTML responses as content without scanning', () => {
    const parse = vi.fn(load);

    expect(
      classifyResponse(
        { html: 'verify you are human data-sitekey', contentType: 'text/plain' },
        parse,
      ),
    ).toEqual({ kind: 'content' });
    expect(parse).not.toHaveBeenCalled();
  });

  it('pays for no DOM parse on a marker-free page, and one on a marker hit', () => {
    const parse = vi.fn(load);

    classifyResponse({ html: PLAIN_ARTICLE, contentType: HTML }, parse);
    classifyResponse({ html: SCRIPT_SHELL, contentType: HTML }, parse);
    expect(parse).not.toHaveBeenCalled();

    classifyResponse({ html: SMALL_INTERSTITIAL, contentType: HTML }, parse);
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('classifies an interstitial served with no content type', () => {
    expect(classify(SMALL_INTERSTITIAL, null)).toEqual({
      kind: 'challenge',
      marker: 'data-sitekey',
    });
  });

  it('never names a host, URL, or brand in the marker list', () => {
    const values = JSON.stringify(CHALLENGE_MARKERS);

    expect(values).not.toMatch(/https?:|\.com|www\./iu);
  });
});
