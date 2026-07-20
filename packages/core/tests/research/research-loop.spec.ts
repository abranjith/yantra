import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateBrief } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { AskEthicsGate } from '../../src/extraction/ethics-adapter.js';
import type { ContentFetcher } from '../../src/extraction/fetcher.js';
import type { Extractor } from '../../src/extraction/readability.js';
import type { SearchProvider } from '../../src/extraction/search/registry.js';
import type { ExtractedArticle, FetchedDoc, SearchResult } from '../../src/extraction/types.js';
import type { DomainRankSignal, RankSignalSink } from '../../src/ranking/types.js';
import { FollowUpQueryGenerator } from '../../src/research/query-gen.js';
import { ResearchLoop } from '../../src/research/research-loop.js';
import type { ResearchOptions } from '../../src/research/types.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'q'
  );
}

/** Deterministic search over any query: N distinct URLs derived from the query. */
class FakeSearch implements SearchProvider {
  public readonly name = 'duckduckgo' as const;
  public readonly queries: string[] = [];

  public constructor(
    private readonly perQuery = 3,
    private readonly override?: (query: string) => readonly SearchResult[],
  ) {}

  public search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    this.queries.push(query);
    if (this.override) {
      return Promise.resolve(this.override(query));
    }
    const rows: SearchResult[] = [];
    for (let i = 0; i < Math.min(this.perQuery, opts.limit); i += 1) {
      rows.push({
        url: `https://${slug(query)}-${i}.example/a`,
        title: `${query} ${i}`,
        snippet: null,
        source: 'duckduckgo',
        rank: i,
        publishedAt: null,
      });
    }
    return Promise.resolve(rows);
  }
}

/** Fetcher that advances an injected budget clock, enabling wall-clock tests. */
class FakeFetcher implements ContentFetcher {
  public constructor(private readonly onFetch?: () => void) {}

  public fetch(url: string): Promise<FetchedDoc> {
    this.onFetch?.();
    return Promise.resolve({
      url,
      finalUrl: url,
      fetchedAt: '2026-05-11T10:00:00.000Z',
      contentType: 'text/html',
      html: `<html><body>${url}</body></html>`,
      statusCode: 200,
      fetchMode: 'http',
      elapsedMs: 10,
    });
  }
}

/** Extractor producing distinct article text per URL (never near-dup). */
class FakeExtractor implements Extractor {
  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    const key = doc.url.replace(/[^a-z0-9]+/gi, ' ').trim();
    const text = `Detailed coverage of ${key} explains how ${key} evolved, why ${key} matters, and what ${key} means for the future of the subject in depth.`;
    return Promise.resolve({
      url: doc.url,
      title: `Article ${key}`,
      byline: null,
      publishedAt: null,
      siteName: doc.url,
      contentText: text,
      contentHtml: `<p>${text}</p>`,
      excerpt: text.slice(0, 100),
      lengthChars: text.length,
    });
  }
}

const allowEthics: AskEthicsGate = {
  checkUrl: () => Promise.resolve({ ok: true }),
};

function baseOptions(overrides: Partial<ResearchOptions> = {}): ResearchOptions {
  return {
    topic: 'renewable energy',
    budget: { maxHops: 1, maxSources: 24, maxWallClockMs: 1_000_000, maxLlmCalls: 12 },
    noLlm: true,
    length: 'long',
    scope: 'public',
    perQueryLimit: 3,
    perFetchTimeoutMs: 8_000,
    coverageTarget: 0.9,
    ...overrides,
  };
}

const tempDirs: string[] = [];

async function makeRunRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-research-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Extractor producing several distinct on-topic sentences per URL, so the
 * interim Brief has more claims than the budget and therefore real sections —
 * which the coverage tracker turns into gaps for multi-hop tests.
 */
class RichExtractor implements Extractor {
  private static readonly THEMES: readonly (readonly string[])[] = [
    [
      'Solar renewable energy farms added record capacity across sunny southern states.',
      'Rooftop solar renewable energy adoption rose as home installation costs declined.',
      'Utility solar renewable energy projects secured new long-term supply contracts.',
    ],
    [
      'Offshore wind renewable energy turbines began feeding the coastal power grid.',
      'Onshore wind renewable energy permits accelerated across the open plains region.',
      'Wind renewable energy generation set an overnight national output record.',
    ],
    [
      'Pumped hydro renewable energy storage balanced the grid during peak demand.',
      'Hydroelectric renewable energy dams increased seasonal reservoir water output.',
      'Small hydro renewable energy plants expanded rural village electricity access.',
    ],
  ];

  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    const n = Number(/-(\d+)\./u.exec(doc.url)?.[1] ?? '0');
    const sentences = RichExtractor.THEMES[n % RichExtractor.THEMES.length]!;
    const text = sentences.join(' ');
    return Promise.resolve({
      url: doc.url,
      title: `Renewable energy report ${n}`,
      byline: null,
      publishedAt: null,
      siteName: doc.url,
      contentText: text,
      contentHtml: `<p>${text}</p>`,
      excerpt: text.slice(0, 100),
      lengthChars: text.length,
    });
  }
}

function makeLoop(deps: {
  search?: SearchProvider;
  fetcher?: ContentFetcher;
  extractor?: Extractor;
  runRootDir: string;
  budgetNow?: () => number;
  rankSink?: RankSignalSink;
}): ResearchLoop {
  return new ResearchLoop({
    searchProvider: deps.search ?? new FakeSearch(),
    fetcher: deps.fetcher ?? new FakeFetcher(),
    extractor: deps.extractor ?? new FakeExtractor(),
    ethicsGate: allowEthics,
    synthesizer: new DeterministicSynthesizer({
      clock: () => new Date('2026-06-15T00:00:00.000Z'),
    }),
    queryGen: new FollowUpQueryGenerator(),
    logger,
    runRootDir: deps.runRootDir,
    clock: () => new Date('2026-06-15T00:00:00.000Z'),
    ...(deps.budgetNow ? { budgetNow: deps.budgetNow } : {}),
    ...(deps.rankSink ? { rankSink: deps.rankSink } : {}),
  });
}

async function eventKinds(
  runRootDir: string,
  brief: { metadata: { run_id: string | null } },
): Promise<string[]> {
  const runId = brief.metadata.run_id!;
  const raw = await readFile(join(runRootDir, runId, 'events.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { kind: string }).kind);
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('@no-llm research/research-loop', () => {
  it('produces a valid long-form Brief from a single depth-1 hop', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop({ runRootDir });

    const result = await loop.run(baseOptions());

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.brief.sources.length).toBeGreaterThan(0);
    expect(result.hops).toHaveLength(1);
    expect(result.terminationReason).toBe('max_hops');
    // Coverage from the tracker lands in the final Brief metadata.
    expect(result.brief.metadata.coverage).not.toBeNull();
  });

  it('stops cleanly with a budget_exhausted notice when the wall-clock fires mid-fetch', async () => {
    const runRootDir = await makeRunRoot();
    let clock = 0;
    const fetcher = new FakeFetcher(() => {
      clock += 600;
    });
    const loop = makeLoop({ runRootDir, fetcher, budgetNow: () => clock });

    const result = await loop.run(
      baseOptions({
        budget: { maxHops: 3, maxSources: 24, maxWallClockMs: 1_000, maxLlmCalls: 12 },
      }),
    );

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.terminationReason).toBe('wall_clock');
    expect(result.brief.notices.some((notice) => notice.kind === 'budget_exhausted')).toBe(true);
    // Partial: fewer sources than the search would have supplied.
    expect(result.brief.sources.length).toBeGreaterThan(0);
  });

  it('emits an honest empty-ish Brief with a notice when search returns nothing', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop({ runRootDir, search: new FakeSearch(3, () => []) });

    const result = await loop.run(baseOptions());

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.brief.sources).toHaveLength(0);
    expect(result.brief.notices.some((notice) => notice.source === 'search')).toBe(true);
  });

  it('records the expected event sequence', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop({ runRootDir });

    const result = await loop.run(baseOptions());
    const kinds = await eventKinds(runRootDir, result.brief);

    expect(kinds[0]).toBe('task_started');
    expect(kinds).toContain('research_hop_completed');
    expect(kinds).toContain('synthesis_completed');
    expect(kinds[kinds.length - 1]).toBe('task_completed');
  });

  it('issues novel hop-2 queries distinct from hop-1 (multi-hop)', async () => {
    const runRootDir = await makeRunRoot();
    const search = new FakeSearch();
    // Rich corpus → interim Brief has sections → coverage gaps → a real hop 2.
    const loop = makeLoop({ runRootDir, search, extractor: new RichExtractor() });

    const result = await loop.run(
      baseOptions({
        budget: { maxHops: 2, maxSources: 24, maxWallClockMs: 1_000_000, maxLlmCalls: 12 },
        coverageTarget: 1.1, // never reachable → run both hops
      }),
    );

    expect(result.hops).toHaveLength(2);
    const hop1 = new Set(result.hops[0]!.queries);
    const hop2 = result.hops[1]!.queries;
    expect(hop2.length).toBeGreaterThan(0);
    for (const query of hop2) {
      expect(hop1.has(query)).toBe(false);
    }
  });

  it('records search hits and extraction failures without duplicate synthesis signals', async () => {
    const runRootDir = await makeRunRoot();
    const signals: DomainRankSignal[] = [];
    const loop = makeLoop({
      runRootDir,
      extractor: { extract: async () => null },
      rankSink: { record: (signal) => signals.push(signal) },
    });

    await loop.run(baseOptions());

    expect(signals.filter((signal) => signal.reason === 'search_result')).toHaveLength(3);
    expect(signals.filter((signal) => signal.reason === 'extract_failed')).toHaveLength(3);
    expect(signals).toHaveLength(6);
  });

  it('does not let a throwing rank sink alter research results', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop({
      runRootDir,
      rankSink: {
        record: () => {
          throw new Error('rank sink unavailable');
        },
      },
    });

    const result = await loop.run(baseOptions());

    expect(result.brief.sources.length).toBeGreaterThan(0);
    expect(result.terminationReason).toBe('max_hops');
  });
});
