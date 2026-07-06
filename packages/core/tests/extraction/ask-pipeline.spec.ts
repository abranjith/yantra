import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateBrief, type Brief } from '@yantra/protocol';
import { makeBrief } from '@yantra/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';

import { AskPipeline } from '../../src/extraction/ask-pipeline.js';
import { cacheKey } from '../../src/extraction/cache-key.js';
import type { AskCache } from '../../src/extraction/cache.js';
import { FetchError } from '../../src/extraction/fetcher.js';
import type {
  AskQuery,
  ExtractedArticle,
  FetchedDoc,
  SearchResult,
} from '../../src/extraction/types.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';

class InMemoryAskCache implements AskCache {
  private readonly store = new Map<string, Brief>();
  public getCalls = 0;
  public putCalls = 0;

  public get(key: string): Promise<Brief | null> {
    this.getCalls += 1;
    return Promise.resolve(this.store.get(key) ?? null);
  }

  public put(key: string, brief: Brief): Promise<void> {
    this.putCalls += 1;
    this.store.set(key, brief);
    return Promise.resolve();
  }

  public delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
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
  length: 'medium',
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
    source: 'duckduckgo',
    rank: 0,
    publishedAt: null,
  },
  {
    url: 'https://example.com/two',
    title: 'Two',
    snippet: 'two',
    source: 'duckduckgo',
    rank: 1,
    publishedAt: null,
  },
  {
    url: 'https://example.com/three',
    title: 'Three',
    snippet: 'three',
    source: 'duckduckgo',
    rank: 2,
    publishedAt: null,
  },
];

// Distinct article bodies so the deterministic synthesizer keeps three sources
// (near-identical text would cluster into one).
const ARTICLE_TEXT: Record<string, string> = {
  one: 'Solar capacity grew twelve percent last year. The national grid added four gigawatts of renewable power. Officials confirmed new incentives for rooftop installations.',
  two: 'The transit authority approved a forty-five million dollar budget. Fares will remain frozen through 2027. Ridership recovered to pre-pandemic levels this quarter.',
  three:
    'Retail headphone prices climbed four percent this week. Amazon listed the flagship model at 328 dollars. Analysts expect discounts to return after the holiday.',
};

function pathId(url: string): string {
  return url.split('/').pop() ?? 'x';
}

function makeDoc(url: string): FetchedDoc {
  return {
    url,
    finalUrl: url,
    fetchedAt: '2026-05-11T10:14:00.000Z',
    contentType: 'text/html',
    html: `<html><main><article><p>${ARTICLE_TEXT[pathId(url)] ?? 'content'}</p></article></main></html>`,
    statusCode: 200,
    fetchMode: 'http',
    elapsedMs: 20,
  };
}

function makeArticle(url: string): ExtractedArticle {
  const text = ARTICLE_TEXT[pathId(url)] ?? 'content';
  return {
    url,
    title: `Article ${pathId(url)}`,
    byline: null,
    publishedAt: null,
    siteName: 'example.com',
    contentText: text,
    contentHtml: `<p>${text}</p>`,
    excerpt: text.slice(0, 120),
    lengthChars: text.length,
  };
}

function makeSynthesizer(): DeterministicSynthesizer {
  return new DeterministicSynthesizer({ clock: () => new Date('2026-06-15T00:00:00.000Z') });
}

const tempDirs: string[] = [];

async function makeRunDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-ask-pipeline-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('@no-llm extraction/ask-pipeline', () => {
  it('produces a schema-valid Brief with a source per successful fetch', async () => {
    const cache = new InMemoryAskCache();
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.finalUrl) },
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    const { brief, artifacts } = await pipeline.run(baseQuery);

    expect(validateBrief(brief).isOk).toBe(true);
    expect(brief.schema_version).toBe('0.2');
    expect(brief.sources).toHaveLength(3);
    expect(brief.notices).toHaveLength(0);
    expect(artifacts).not.toBeNull();
    expect(cache.putCalls).toBe(1);
  });

  it('returns the identical cached Brief on a cache hit without searching', async () => {
    const cache = new InMemoryAskCache();
    const cachedBrief = makeBrief({ title: 'Cached answer' });
    await cache.put(cacheKey(baseQuery.normalized, 'duckduckgo', '2026-05-11'), cachedBrief);

    const pipeline = new AskPipeline({
      searchProvider: {
        name: 'duckduckgo',
        search: async () => {
          throw new Error('should not search on cache hit');
        },
      },
      fetcher: {
        fetch: async () => {
          throw new Error('should not fetch on cache hit');
        },
      },
      extractor: { extract: async () => null },
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      clock: () => new Date('2026-05-11T10:14:00.000Z'),
      synthesizer: makeSynthesizer(),
    });

    const { brief } = await pipeline.run({ ...baseQuery, searchProvider: 'duckduckgo' });

    expect(brief.brief_id).toBe(cachedBrief.brief_id);
    expect(brief.title).toBe('Cached answer');
    expect(cache.getCalls).toBe(1);
  });

  it('does not read or write the cache when noCache=true', async () => {
    const cache = new InMemoryAskCache();
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    await pipeline.run({ ...baseQuery, noCache: true });

    expect(cache.getCalls).toBe(0);
    expect(cache.putCalls).toBe(0);
  });

  it('surfaces an ethics refusal as a Brief notice, not a dropped source', async () => {
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      cache: new InMemoryAskCache(),
      ethicsGate: {
        checkUrl: async (url) =>
          url.endsWith('/two')
            ? ({ ok: false, reason: 'robots', detail: 'disallowed' } as const)
            : ({ ok: true } as const),
      },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    const { brief } = await pipeline.run(baseQuery);

    expect(brief.sources).toHaveLength(2);
    expect(brief.notices.some((notice) => notice.kind === 'blocked')).toBe(true);
  });

  it('surfaces a fetch timeout as a fetch_failed notice', async () => {
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: {
        fetch: async (url) => {
          if (url.endsWith('/three')) {
            throw new FetchError('timed out', { url, kind: 'timeout' });
          }
          return makeDoc(url);
        },
      },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      cache: new InMemoryAskCache(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    const { brief } = await pipeline.run(baseQuery);

    expect(brief.notices.some((notice) => notice.kind === 'fetch_failed')).toBe(true);
  });

  it('returns a Brief with notices (not a throw) when every source fails', async () => {
    const cache = new InMemoryAskCache();
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: {
        fetch: async (url) => {
          throw new FetchError('boom', { url, kind: 'network' });
        },
      },
      extractor: { extract: async () => null },
      cache,
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    const { brief } = await pipeline.run(baseQuery);

    expect(brief.sources).toHaveLength(0);
    expect(brief.notices.filter((notice) => notice.kind === 'fetch_failed')).toHaveLength(3);
    // All-failed Briefs are not cached, so the day can be retried.
    expect(cache.putCalls).toBe(0);
  });

  it('yields a partial Brief with a budget_exhausted notice when the budget fires', async () => {
    const pipeline = new AskPipeline({
      searchProvider: {
        name: 'duckduckgo',
        search: (_query, opts) =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      cache: new InMemoryAskCache(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir: await makeRunDir(),
      synthesizer: makeSynthesizer(),
    });

    const { brief } = await pipeline.run({ ...baseQuery, pipelineBudgetMs: 5 });

    expect(brief.notices.some((notice) => notice.kind === 'budget_exhausted')).toBe(true);
  });

  it('writes brief.json/md/html and emits synthesis_completed', async () => {
    const runRootDir = await makeRunDir();
    const pipeline = new AskPipeline({
      searchProvider: { name: 'duckduckgo', search: async () => searchRows },
      fetcher: { fetch: async (url) => makeDoc(url) },
      extractor: { extract: async (doc) => makeArticle(doc.url) },
      cache: new InMemoryAskCache(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
      runRootDir,
      synthesizer: makeSynthesizer(),
    });

    await pipeline.run({ ...baseQuery, noCache: true });

    const runIds = await readdir(runRootDir);
    expect(runIds).toHaveLength(1);
    const runDir = join(runRootDir, runIds[0]!);

    const brief = JSON.parse(await readFile(join(runDir, 'brief.json'), 'utf8')) as {
      schema_version: string;
    };
    expect(brief.schema_version).toBe('0.2');
    expect((await readFile(join(runDir, 'brief.md'), 'utf8')).startsWith('# ')).toBe(true);
    expect((await readFile(join(runDir, 'brief.html'), 'utf8')).startsWith('<!DOCTYPE html>')).toBe(
      true,
    );

    const events = (await readFile(join(runDir, 'events.jsonl'), 'utf8'))
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: string; strategy?: string; sources_in?: number });
    const synth = events.find((event) => event.kind === 'synthesis_completed');
    expect(synth?.strategy).toBe('deterministic');
    expect(synth?.sources_in).toBe(3);
  });
});
