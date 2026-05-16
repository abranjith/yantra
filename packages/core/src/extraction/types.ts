/** Search provider names supported by the ask pipeline. */
export type SearchProviderName = 'tavily' | 'brave' | 'browser';

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

/** User-facing ask output card. */
export interface AskCard {
  readonly url: string;
  readonly title: string;
  readonly source: string;
  readonly fetchedAt: string;
  readonly publishedAt: string | null;
  readonly summary: string;
  readonly summaryKind: 'rule-based' | 'llm-enhanced' | 'fallback-lede';
  readonly quotedSnippet: string;
  readonly tags: readonly string[];
  readonly notice: string | null;
}
