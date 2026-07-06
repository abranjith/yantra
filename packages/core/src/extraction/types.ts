import type { Sanitized } from '../sanitizer/brand.js';
import type { SynthesisLength } from '../synthesis/types.js';

/**
 * First-class search provider names supported by the ask pipeline.
 *
 * Each name maps 1:1 to a descriptor in the search registry
 * (`extraction/search/registry.ts`). `google` and `duckduckgo` are scraped
 * providers (no API key); `brave` and `tavily` are keyed API providers. The
 * former internal `browser` name (DuckDuckGo HTML scraping) is gone — it is now
 * the named `duckduckgo` provider riding the shared scrape transport.
 */
export type SearchProviderName = 'google' | 'duckduckgo' | 'brave' | 'tavily';

/**
 * Parsed ask query options used by the extraction pipeline.
 */
export interface AskQuery {
  readonly raw: string;
  readonly normalized: string;
  readonly limit: number;
  readonly noCache: boolean;
  readonly noLlm: boolean;
  readonly budgetCalls: number | null;
  readonly searchProvider: SearchProviderName | null;
  readonly perFetchTimeoutMs: number;
  readonly pipelineBudgetMs: number;
  /** Synthesis length budget (findings/sections count); defaults to `medium`. */
  readonly length: SynthesisLength;
  /**
   * Optional privacy-gated personalization context (FEAT-018). Sanitized-branded
   * so only `buildPersonalizationContext` output can populate it. Forwarded to
   * the LLM synthesizer; the deterministic path ignores it.
   */
  readonly personalization?: Sanitized<string>;
}

/** A single search provider hit before fetch/extract. */
export interface SearchResult {
  readonly url: string;
  readonly title: string | null;
  readonly snippet: string | null;
  readonly source: SearchProviderName;
  readonly rank: number;
  readonly publishedAt: string | null;
}

/** Raw fetched document metadata + HTML payload. */
export interface FetchedDoc {
  readonly url: string;
  readonly finalUrl: string;
  readonly fetchedAt: string;
  readonly contentType: string | null;
  readonly html: string;
  readonly statusCode: number;
  readonly fetchMode: 'http' | 'browser';
  readonly elapsedMs: number;
}

/** Normalized article extracted from fetched HTML. */
export interface ExtractedArticle {
  readonly url: string;
  readonly title: string | null;
  readonly byline: string | null;
  readonly publishedAt: string | null;
  readonly siteName: string | null;
  readonly contentText: string;
  readonly contentHtml: string;
  readonly excerpt: string | null;
  readonly lengthChars: number;
}
