import { Readability } from '@mozilla/readability';
import { load } from 'cheerio';
import { JSDOM } from 'jsdom';

import type { ExtractedArticle, FetchedDoc } from './types.js';

export interface Extractor {
  extract(doc: FetchedDoc): Promise<ExtractedArticle | null>;
}

/**
 * Readability-based extraction pipeline with a small pre-clean pass.
 */
export class ReadabilityExtractor implements Extractor {
  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    try {
      const $ = load(doc.html);
      $(
        'nav,aside,footer,form,[role="banner"],[role="contentinfo"],[aria-hidden="true"],.cookie-banner,.ad,.advertisement,script,style,iframe,noscript',
      ).remove();

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

      return Promise.resolve({
        url: doc.finalUrl,
        title: parsed.title ?? null,
        byline: parsed.byline ?? null,
        publishedAt: extractPublishedAt($),
        siteName: parsed.siteName ?? null,
        contentText: parsed.textContent,
        contentHtml: parsed.content ?? '',
        excerpt: parsed.excerpt ?? null,
        lengthChars: parsed.textContent.length,
      });
    } catch {
      return Promise.resolve(null);
    }
  }
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
