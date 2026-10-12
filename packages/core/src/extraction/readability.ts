import { Readability } from '@mozilla/readability';
import { load, type CheerioAPI } from 'cheerio';
import { JSDOM } from 'jsdom';

import { htmlNodesToText, htmlToText } from './html-to-text.js';
import { analyzePage, completeAnalysis } from './page/analyze.js';
import { findJsonLdString, parseJsonLdBlocks } from './page/structured.js';
import type { PageExtraction } from './page/types.js';
import type { ExtractedArticle, FetchedDoc } from './types.js';

export interface Extractor {
  extract(doc: FetchedDoc): Promise<ExtractedArticle | null>;
}

/** Options for one shape-aware read. */
export interface ExtractPageOptions {
  /** The HTML was cut at a byte cap (a live-page snapshot); reported in coverage. */
  readonly truncated?: boolean;
}

/**
 * An {@link Extractor} that can also read a page's shape (FEAT-051).
 * `extract()` stays article-only and runs no analysis, so the deterministic
 * `ask` and `research` pipelines are unchanged.
 */
export interface PageExtractor extends Extractor {
  extractPage(doc: FetchedDoc, options?: ExtractPageOptions): Promise<PageExtraction>;
}

/** Injectable seams, used by tests to count parses and DOM constructions. */
export interface ReadabilityExtractorOptions {
  /** Parses HTML; defaults to cheerio's `load`. */
  readonly parseHtml?: (html: string) => CheerioAPI;
  /** Builds the DOM Readability reads; defaults to a JSDOM document at the page URL. */
  readonly createDocument?: (html: string, url: string) => Document;
}

/**
 * Elements removed before Readability runs: page chrome plus source-footnote
 * and infobox/navbox markup (Wikipedia-style `sup.reference` markers otherwise
 * survive into the text as `[45]` and get mistaken for citation markers).
 */
const PRE_CLEAN_SELECTOR = [
  'nav',
  'aside',
  'footer',
  'form',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]',
  '.cookie-banner',
  '.ad',
  '.advertisement',
  'script',
  'style',
  'iframe',
  'noscript',
  'sup.reference',
  'sup[class*="reference"]',
  '[role="doc-noteref"]',
  '.mw-editsection',
  'table.infobox',
  'table[class*="infobox"]',
  '.navbox',
  '.vertical-navbox',
  '.sidebar',
  '.reflist',
].join(',');

/**
 * Readability-based extraction pipeline with a small pre-clean pass.
 *
 * `contentText` is **block-structured**: it is serialized from Readability's
 * cleaned content HTML via {@link htmlToText} (blank line between block
 * elements, footnote markers stripped) rather than taken from
 * `parsed.textContent`, which glues adjacent blocks together with no
 * separator. Downstream sentence analysis depends on those boundaries.
 *
 * {@link extractPage} adds shape-aware analysis on the **same** parse:
 * analysis reads the untouched tree first (the pre-clean deletes the `nav`,
 * `aside`, `form`, and `script` elements that hold pagination, facets, and
 * JSON-LD), then the identical pre-clean and Readability code runs, so the
 * article half is byte-identical to {@link extract}.
 */
export class ReadabilityExtractor implements PageExtractor {
  private readonly parseHtml: (html: string) => CheerioAPI;
  private readonly createDocument: (html: string, url: string) => Document;

  public constructor(options: ReadabilityExtractorOptions = {}) {
    this.parseHtml = options.parseHtml ?? ((html) => load(html));
    this.createDocument =
      options.createDocument ?? ((html, url) => new JSDOM(html, { url }).window.document);
  }

  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    try {
      return Promise.resolve(this.readArticle(this.parseHtml(doc.html), doc));
    } catch {
      return Promise.resolve(null);
    }
  }

  /**
   * Reads the page's article and its shape from one parse.
   *
   * @param doc The fetched document.
   * @param options Whether the HTML was truncated at a byte cap.
   * @returns The article (null when Readability found none) and the analysis.
   */
  public extractPage(doc: FetchedDoc, options: ExtractPageOptions = {}): Promise<PageExtraction> {
    const $ = this.parseHtml(doc.html);
    const scan = analyzePage($, { baseUrl: doc.finalUrl, fetchMode: doc.fetchMode });
    const article = this.readArticle($, doc);
    // The pre-clean has run on `$` by now, so the fallback is the body minus
    // page chrome — serialized from the same parse, not parsed again.
    const fallbackText = article === null ? htmlNodesToText($('body').toArray()) : '';
    return Promise.resolve({
      article,
      page: completeAnalysis(scan, {
        articleText: article?.contentText ?? null,
        fallbackText,
        ...(options.truncated === true ? { truncatedSource: true } : {}),
      }),
    });
  }

  /**
   * Pre-clean → JSDOM → Readability → block-structured text. Mutates `$`
   * (the pre-clean). Null when there is no article or Readability fails.
   */
  private readArticle($: CheerioAPI, doc: FetchedDoc): ExtractedArticle | null {
    try {
      $(PRE_CLEAN_SELECTOR).remove();

      const cleanedHtml = $.html();
      const parsed = new Readability(this.createDocument(cleanedHtml, doc.finalUrl)).parse();
      if (
        !parsed ||
        typeof parsed.textContent !== 'string' ||
        parsed.textContent.trim().length === 0
      ) {
        return null;
      }

      const structuredText = htmlToText(parsed.content ?? '');
      const contentText = structuredText.length > 0 ? structuredText : parsed.textContent;

      return {
        url: doc.finalUrl,
        title: normalizeTitle(parsed.title),
        byline: parsed.byline ?? null,
        publishedAt: extractPublishedAt($),
        siteName: parsed.siteName ?? null,
        contentText,
        contentHtml: parsed.content ?? '',
        excerpt: parsed.excerpt ?? null,
        lengthChars: contentText.length,
      };
    } catch {
      // swallow-ok: Readability's null-on-failure contract; an unreadable page is "no article".
      return null;
    }
  }
}

/** Collapses whitespace (including NBSP variants) in an extracted title. */
function normalizeTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined) {
    return null;
  }
  const cleaned = title.replace(/[   ]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
}

function extractPublishedAt($: CheerioAPI): string | null {
  const meta = $('meta[property="article:published_time"]').attr('content');
  const metaIso = normalizeIso(meta);
  if (metaIso) {
    return metaIso;
  }

  const timeTag = $('time[datetime]').attr('datetime');
  const timeIso = normalizeIso(timeTag);
  if (timeIso) {
    return timeIso;
  }

  // One JSON-LD grammar (FEAT-051): the same bounded reader page analysis
  // uses. Malformed blocks are counted there and simply contribute nothing.
  const scripts = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).contents().text())
    .get();
  for (const value of parseJsonLdBlocks(scripts).values) {
    const iso = normalizeIso(findJsonLdString([value], 'datePublished'));
    if (iso) {
      return iso;
    }
  }

  return null;
}

function normalizeIso(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
