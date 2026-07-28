/**
 * Shared readable-text stage for a **live page**: `extract → normalize`.
 *
 * This is the no-fetch sibling of {@link processSource}. That pipeline exists
 * for a URL nobody has loaded yet, so it opens with `ethics → fetch`; here the
 * document is already open in a browser the user drove there, so both stages
 * are already behind us and only extraction remains.
 *
 * Three callers need exactly this — the agent's observation digest
 * (`discovery/observe.ts`), the replayed `extract` step's `readable` schema
 * (`executor/step-handlers/extract.ts`), and anything later that reads a page
 * the agent is already on. Each of them was otherwise obliged to hand-roll the
 * same two things: the synthetic {@link FetchedDoc} that {@link Extractor}
 * requires, and a decision about what to do when Readability finds no article.
 * Divergence there is what made the agent and replay read the same page
 * differently (memory §General: no duplicated logic).
 *
 * Never throws: a failed extraction degrades to the caller's fallback text, or
 * to an empty string. A page read must not be able to fail a run — an empty
 * digest is a fact the caller can report, a thrown error is not.
 */

import { normalizeExtractedText } from './html-to-text.js';
import type { Extractor } from './readability.js';
import type { ExtractedArticle, FetchedDoc } from './types.js';

/** Injected stage dependency — the same {@link Extractor} the fetch path uses. */
export interface LivePageDeps {
  readonly extractor: Extractor;
}

/** A document read straight out of an open browser page. */
export interface LivePageSource {
  /** The page's current URL, used to resolve relative links during parsing. */
  readonly url: string;
  /** Serialized markup: the document's or one element's `outerHTML`. */
  readonly html: string;
  /**
   * The rendered text of the same subtree (`innerText`), used **only** when
   * Readability finds no article.
   *
   * That is not an edge case: Readability targets prose documents, and the
   * pages workflows run against — a tracking result, an order summary, an app
   * shell — frequently have none. Returning empty there would make a terminal
   * read useless on exactly the pages it exists for.
   *
   * It must be `innerText` rather than `textContent` or the raw HTML, because
   * only the rendered form reflects what the user could actually see:
   * `display:none` subtrees and `<script>` bodies stay out, and block
   * boundaries survive as newlines. Omit it to accept an empty string when
   * there is no article.
   */
  readonly visibleText?: string;
  /** ISO timestamp of the read; defaults to now. Pass a clock-derived value
   * from contexts that must stay deterministic. */
  readonly fetchedAt?: string;
}

/**
 * Extracts an article-like document from an already-loaded page.
 *
 * @param deps - The extractor stage.
 * @param source - The live page's markup and rendered text.
 * @returns The extracted article, or null when there is no article to find.
 */
export async function extractLivePageArticle(
  deps: LivePageDeps,
  source: LivePageSource,
): Promise<ExtractedArticle | null> {
  if (source.html.length === 0) {
    return null;
  }
  try {
    return await deps.extractor.extract(toFetchedDoc(source));
  } catch {
    return null;
  }
}

/**
 * Reads a live page as clean, block-structured text.
 *
 * Prefers Readability's article — page chrome, cookie banners, and inline
 * script source stripped — and falls back to the caller's rendered
 * `visibleText`, normalized through the very same pass the article text went
 * through, so the two paths differ in *what* they select and never in how the
 * result is cleaned.
 *
 * @param deps - The extractor stage.
 * @param source - The live page's markup and rendered text.
 * @returns The page's readable text, or `''` when nothing could be read.
 *
 * @example
 * const text = await extractLivePageText(
 *   { extractor },
 *   { url: page.url(), html: outerHTML, visibleText: innerText },
 * );
 */
export async function extractLivePageText(
  deps: LivePageDeps,
  source: LivePageSource,
): Promise<string> {
  const article = await extractLivePageArticle(deps, source);
  const readable = article?.contentText.trim() ?? '';
  if (readable.length > 0) {
    return readable;
  }
  return normalizeExtractedText(source.visibleText ?? '');
}

/**
 * Wraps live markup in the {@link FetchedDoc} shape {@link Extractor} takes.
 *
 * The HTTP-flavored fields are honest constants for this path: the browser
 * holds a parsed HTML document it already rendered, so `text/html` and `200`
 * describe it, and `elapsedMs` has no fetch to measure. `fetchMode: 'browser'`
 * is what distinguishes these docs downstream.
 */
function toFetchedDoc(source: LivePageSource): FetchedDoc {
  return {
    url: source.url,
    finalUrl: source.url,
    fetchedAt: source.fetchedAt ?? new Date().toISOString(),
    contentType: 'text/html',
    html: source.html,
    statusCode: 200,
    fetchMode: 'browser',
    elapsedMs: 0,
  };
}
