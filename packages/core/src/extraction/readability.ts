import { Readability } from '@mozilla/readability';
import { load } from 'cheerio';
import { JSDOM } from 'jsdom';

import { htmlToText } from './html-to-text.js';
import type { ExtractedArticle, FetchedDoc } from './types.js';

export interface Extractor {
  extract(doc: FetchedDoc): Promise<ExtractedArticle | null>;
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
 */
export class ReadabilityExtractor implements Extractor {
  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    try {
      const $ = load(doc.html);
      $(PRE_CLEAN_SELECTOR).remove();

      const cleanedHtml = $.html();
      const window = new JSDOM(cleanedHtml, { url: doc.finalUrl }).window;
      const parsed = new Readability(window.document).parse();
      if (
        !parsed ||
        typeof parsed.textContent !== 'string' ||
        parsed.textContent.trim().length === 0
      ) {
        return Promise.resolve(null);
      }

      const structuredText = htmlToText(parsed.content ?? '');
      const contentText = structuredText.length > 0 ? structuredText : parsed.textContent;

      return Promise.resolve({
        url: doc.finalUrl,
        title: normalizeTitle(parsed.title),
        byline: parsed.byline ?? null,
        publishedAt: extractPublishedAt($),
        siteName: parsed.siteName ?? null,
        contentText,
        contentHtml: parsed.content ?? '',
        excerpt: parsed.excerpt ?? null,
        lengthChars: contentText.length,
      });
    } catch {
      return Promise.resolve(null);
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

function extractPublishedAt($: ReturnType<typeof load>): string | null {
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

  const scripts = $('script[type="application/ld+json"]')
    .map((_, element) => $(element).contents().text())
    .get();

  for (const script of scripts) {
    try {
      const parsed = JSON.parse(script) as unknown;
      const value = extractJsonLdDatePublished(parsed);
      const iso = normalizeIso(value);
      if (iso) {
        return iso;
      }
    } catch {
      // Ignore malformed JSON-LD blocks.
    }
  }

  return null;
}

function extractJsonLdDatePublished(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractJsonLdDatePublished(item);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const asRecord = value as Record<string, unknown>;
  if (typeof asRecord.datePublished === 'string') {
    return asRecord.datePublished;
  }

  for (const nested of Object.values(asRecord)) {
    const candidate = extractJsonLdDatePublished(nested);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function normalizeIso(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}
