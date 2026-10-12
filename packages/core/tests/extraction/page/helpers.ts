import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { load } from 'cheerio';

import {
  analyzePage,
  completeAnalysis,
  type PageScan,
} from '../../../src/extraction/page/analyze.js';
import type { PageAnalysis } from '../../../src/extraction/page/types.js';
import { ReadabilityExtractor } from '../../../src/extraction/readability.js';
import type { FetchedDoc } from '../../../src/extraction/types.js';

/** Reads a page fixture from `__fixtures__/page/`. */
export function pageFixture(name: string): string {
  return readFileSync(resolve(import.meta.dirname, `../__fixtures__/page/${name}`), 'utf8');
}

/** A fetched document around literal HTML. */
export function makeDoc(
  url: string,
  html: string,
  fetchMode: 'http' | 'browser' = 'http',
): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-10-12T00:00:00.000Z',
    contentType: 'text/html',
    html,
    statusCode: 200,
    fetchMode,
    elapsedMs: 1,
  };
}

/** Runs only the structural scan (no Readability). */
export function scan(html: string, url = 'https://site.test/list'): PageScan {
  return analyzePage(load(html), { baseUrl: url, fetchMode: 'http' });
}

/** Runs the structural scan and completes it with no article. */
export function analyzeWithoutArticle(html: string, url = 'https://site.test/list'): PageAnalysis {
  return completeAnalysis(scan(html, url), { articleText: null, fallbackText: '' });
}

/** The full shape-aware read, through the real extractor. */
export async function extractPage(
  html: string,
  url = 'https://site.test/list',
): Promise<PageAnalysis> {
  return (await new ReadabilityExtractor().extractPage(makeDoc(url, html))).page;
}

/** A minimal HTML document around a body. */
export function documentWith(body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;
}
