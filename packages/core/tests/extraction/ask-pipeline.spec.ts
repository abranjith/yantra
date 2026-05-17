import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { AskPipeline } from '../../src/extraction/ask-pipeline.js';
import { cacheKey } from '../../src/extraction/cache-key.js';
import type { AskCache } from '../../src/extraction/cache.js';
import { FetchError, type ContentFetcher } from '../../src/extraction/fetcher.js';
import type { Extractor } from '../../src/extraction/readability.js';
import type { SearchProvider } from '../../src/extraction/search/provider.js';
import type { Summarizer } from '../../src/extraction/summarizer.js';
import type {
  AskCard,
  AskQuery,
  ExtractedArticle,
  FetchedDoc,
  SearchResult,
} from '../../src/extraction/types.js';

class InMemoryAskCache implements AskCache {
  private readonly store = new Map<string, readonly AskCard[]>();
  public getCalls = 0;
  public putCalls = 0;

  public async get(key: string): Promise<readonly AskCard[] | null> {
    this.getCalls += 1;
    return this.store.get(key) ?? null;
  }

  public async put(key: string, cards: readonly AskCard[]): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, cards);
  }

  public async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const baseQuery: AskQuery = {
  raw: 'ai news',
  normalized: 'ai news',
  limit: 3,
  noCache: false,
  noLlm: true,
  budgetCalls: null,
  searchProvider: null,
  perFetchTimeoutMs: 8_000,
  pipelineBudgetMs: 30_000,
};

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const searchRows: SearchResult[] = [
  {
    url: 'https://example.com/one',
    title: 'One',
    snippet: 'one',
    source: 'browser',
    rank: 0,
    publishedAt: null,
  },
  {
    url: 'https://example.com/two',
    title: 'Two',
    snippet: 'two',
    source: 'browser',
    rank: 1,
    publishedAt: null,
  },
  {
    url: 'https://example.com/three',
    title: 'Three',
    snippet: 'three',
    source: 'browser',
    rank: 2,
    publishedAt: null,
  },
];

function makeDoc(url: string): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-05-11T10:14:00.000Z',
    contentType: 'text/html',
    html: '<html><main><article><p>AI sentence one. AI sentence two. AI sentence three.</p></article></main></html>',
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 20,
  };
}

function makeArticle(url: string): ExtractedArticle {
  const text =
    'AI sentence one with context. AI sentence two with more detail. AI sentence three for completeness. Additional details for ranking.';
  return {
    url,
    title: 'Article',
    byline: null,
    publishedAt: null,
    siteName: 'example.com',
    contentText: text,
    contentHtml: `<p>${text}</p>`,
    excerpt: text.slice(0, 120),
    lengthChars: text.length,
  };
}

const tempDirs: string[] = [];

async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-ask-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('@no-llm extraction/ask-pipeline', () => {
  it('returns a three-card happy-path deck', async () => {
    const cache = new InMemoryAskCache();
    const searchProvider: SearchProvider = {
      name: 'browser',
      search: async () => searchRows,
    };
    const fetcher: ContentFetcher = {
      fetch: async (url) => makeDoc(url),
    };
    const extractor: Extractor = {
      extract: async (doc) => makeArticle(doc.finalUrl),
    };
    const summarizer: Summarizer = {
      summarize: async () => ({ summary: 'summary', kind: 'rule-based' }),
    };

    const pipeline = new AskPipeline({
      searchProvider,
      fetcher,
      extractor,
      ruleBasedSummarizer: summarizer,
      llmSummarizer: null,
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
    });

    const cards = await pipeline.run(baseQuery);

    expect(cards).toHaveLength(3);
    expect(cards[0]?.notice).toBeNull();
    expect(cache.putCalls).toBe(1);
  });

  it('short-circuits on cache hit', async () => {
    const cache = new InMemoryAskCache();
    const fixedNow = new Date('2026-05-11T10:14:00.000Z');
    await cache.put(cacheKey(baseQuery.normalized, 'browser', '2026-05-11'), [
      {
        url: 'https://example.com/cached',
        title: 'Cached',
        source: 'example.com',
        fetchedAt: '2026-05-11T10:14:00.000Z',
        publishedAt: null,
        summary: 'cached summary',
        summaryKind: 'rule-based',
        quotedSnippet: 'cached snippet',
        tags: ['ai'],
        notice: null,
      },
    ]);

    const pipeline = new AskPipeline({
      searchProvider: {
        name: 'browser',
        search: async () => {
          throw new Error('should not search on cache hit');
        },
      },
      fetcher: {
        fetch: async () => {
          throw new Error('should not fetch on cache hit');
        },
      },
      extractor: {
        extract: async () => null,
      },
      ruleBasedSummarizer: {
        summarize: async () => ({ summary: 'x', kind: 'rule-based' }),
      },
      llmSummarizer: null,
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      clock: () => fixedNow,
    });

    // Use deterministic cache-key query/provider/day by forcing provider to browser.
    const cards = await pipeline.run({ ...baseQuery, searchProvider: 'browser' });

    expect(cards.length).toBeGreaterThan(0);
    expect(cache.getCalls).toBe(1);
  });

  it('does not read or write cache when noCache=true', async () => {
    const cache = new InMemoryAskCache();

    const pipeline = new AskPipeline({
      searchProvider: { name: 'browser', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      ruleBasedSummarizer: { summarize: async () => ({ summary: 'x', kind: 'rule-based' }) },
      llmSummarizer: null,
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
    });

    const cards = await pipeline.run({ ...baseQuery, noCache: true });

    expect(cards).toHaveLength(3);
    expect(cache.getCalls).toBe(0);
    expect(cache.putCalls).toBe(0);
  });

  it('returns notice card when ethics gate refuses one source', async () => {
    const cache = new InMemoryAskCache();

    const pipeline = new AskPipeline({
      searchProvider: { name: 'browser', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      ruleBasedSummarizer: { summarize: async () => ({ summary: 'x', kind: 'rule-based' }) },
      llmSummarizer: null,
      cache,
      ethicsGate: {
        checkUrl: async (url) => {
          if (url.endsWith('/two')) {
            return { ok: false, reason: 'robots', detail: 'disallowed' } as const;
          }
          return { ok: true } as const;
        },
      },
      logger,
      runRootDir: await makeRunDir(),
    });

    const cards = await pipeline.run(baseQuery);

    expect(cards).toHaveLength(3);
    expect(cards.some((card) => card.notice?.includes('skipped') ?? false)).toBe(true);
  });

  it('returns timeout notice card when one fetch times out', async () => {
    const cache = new InMemoryAskCache();

    const pipeline = new AskPipeline({
      searchProvider: { name: 'browser', search: async () => searchRows },
      fetcher: {
        fetch: async (url) => {
          if (url.endsWith('/three')) {
            throw new FetchError('timed out', { url, kind: 'timeout' });
          }
          return makeDoc(url);
        },
      },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      ruleBasedSummarizer: { summarize: async () => ({ summary: 'x', kind: 'rule-based' }) },
      llmSummarizer: null,
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
    });

    const cards = await pipeline.run(baseQuery);

    expect(cards).toHaveLength(3);
    expect(cards.some((card) => card.notice === 'fetch timed out')).toBe(true);
  });

  it('prefers rule-based summarizer when noLlm=true even if llm summarizer exists', async () => {
    const cache = new InMemoryAskCache();
    let llmCalls = 0;
    let ruleCalls = 0;

    const pipeline = new AskPipeline({
      searchProvider: { name: 'browser', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      ruleBasedSummarizer: {
        summarize: async () => {
          ruleCalls += 1;
          return { summary: 'rule summary', kind: 'rule-based' };
        },
      },
      llmSummarizer: {
        summarize: async () => {
          llmCalls += 1;
          return { summary: 'llm summary', kind: 'llm-enhanced' };
        },
      },
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
    });

    await pipeline.run({ ...baseQuery, noLlm: true });

    expect(ruleCalls).toBeGreaterThan(0);
    expect(llmCalls).toBe(0);
  });
});
