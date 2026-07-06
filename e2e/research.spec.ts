import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeterministicSynthesizer,
  FetchError,
  FollowUpQueryGenerator,
  ResearchLoop,
  type AskEthicsGate,
  type ContentFetcher,
  type Extractor,
  type ExtractedArticle,
  type FetchedDoc,
  type Logger,
  type ResearchLoopDependencies,
  type ResearchOptions,
  type SearchProvider,
  type SearchResult,
  type SynthesisLlm,
  type SynthesisLlmError,
  type SynthesisLlmRequest,
  type SynthesisLlmResponse,
} from '@yantra/core';
import { err, validateBrief, type Result } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

// Three genuinely distinct corpus bodies (distinct topics keep them below the
// near-dup threshold) that each carry a lede *fact*, a *number* claim, and an
// *entity* claim — so the deterministic long-form synthesis yields multiple
// kind-grouped sections. The shared "Grid Research Institute" entity recurs
// across docs, which is what qualifies the entity section.
const CORPUS_BODIES: readonly string[] = [
  'Community solar programs transformed rural electricity access this decade. The Global Energy Council recorded 4 gigawatts of fresh rooftop installations. Grid Research Institute analysts highlighted steadily falling battery costs nationwide.',
  'Offshore wind turbines now anchor the entire northern coastline network. The Global Energy Council valued that maritime sector at 328 million dollars. Grid Research Institute forecasts a confident expansion continuing through 2027.',
  'Hydrogen pipelines began linking distant industrial hubs across the continent. Regional cooperatives reported a 12 percent efficiency gain over 2025. Independent operators praised the ambitious modernization and permitting timeline widely.',
];

function bodyFor(i: number): string {
  return CORPUS_BODIES[i % CORPUS_BODIES.length]!;
}

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const allowEthics: AskEthicsGate = { checkUrl: () => Promise.resolve({ ok: true }) };

function slug(query: string): string {
  return (
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'q'
  );
}

class FakeSearch implements SearchProvider {
  public readonly name = 'duckduckgo' as const;
  public hopQuery = 0;

  public constructor(private readonly failOnQuery?: (query: string) => boolean) {}

  public search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    this.hopQuery += 1;
    if (this.failOnQuery?.(query)) {
      return Promise.reject(new Error(`search backend unavailable for "${query}"`));
    }
    const rows: SearchResult[] = [];
    for (let i = 0; i < Math.min(3, opts.limit); i += 1) {
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

class FakeFetcher implements ContentFetcher {
  public constructor(private readonly opts: { onFetch?: () => void; timeout?: boolean } = {}) {}

  public fetch(url: string): Promise<FetchedDoc> {
    this.opts.onFetch?.();
    if (this.opts.timeout) {
      return Promise.reject(new FetchError('timed out', { url, kind: 'timeout' }));
    }
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

class FakeExtractor implements Extractor {
  public extract(doc: FetchedDoc): Promise<ExtractedArticle | null> {
    const i = Number.parseInt(/-(\d+)\.example/.exec(doc.url)?.[1] ?? '0', 10) || 0;
    const text = bodyFor(i);
    return Promise.resolve({
      url: doc.url,
      title: `Report ${i}`,
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

/** An LLM port that always reports unavailable — the hop-2 chaos scenario. */
class UnavailableLlm implements SynthesisLlm {
  public readonly providerId = 'fake:unavailable';
  public send(
    _request: SynthesisLlmRequest,
  ): Promise<Result<SynthesisLlmResponse, SynthesisLlmError>> {
    return Promise.resolve(err({ kind: 'llm_unavailable', message: 'provider offline' }));
  }
}

const tempDirs: string[] = [];

async function makeRunRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-research-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function baseOptions(overrides: Partial<ResearchOptions> = {}): ResearchOptions {
  return {
    topic: 'renewable energy grid',
    budget: { maxHops: 2, maxSources: 24, maxWallClockMs: 1_000_000, maxLlmCalls: 12 },
    noLlm: true,
    length: 'long',
    scope: 'public',
    perQueryLimit: 3,
    perFetchTimeoutMs: 8_000,
    coverageTarget: 1.1, // force both hops for a deterministic multi-hop run
    ...overrides,
  };
}

function makeLoop(
  runRootDir: string,
  overrides: Partial<ResearchLoopDependencies> = {},
): ResearchLoop {
  const deps: ResearchLoopDependencies = {
    searchProvider: new FakeSearch(),
    fetcher: new FakeFetcher(),
    extractor: new FakeExtractor(),
    ethicsGate: allowEthics,
    synthesizer: new DeterministicSynthesizer({
      clock: () => new Date('2026-06-15T00:00:00.000Z'),
    }),
    queryGen: new FollowUpQueryGenerator(),
    logger,
    runRootDir,
    clock: () => new Date('2026-06-15T00:00:00.000Z'),
    ...overrides,
  };
  return new ResearchLoop(deps);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe('@no-llm research e2e', () => {
  it('completes a depth-2 run with a sectioned Brief, coverage, and artifacts', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop(runRootDir);

    const started = Date.now();
    const result = await loop.run(baseOptions());
    const elapsed = Date.now() - started;

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.hops).toHaveLength(2);
    expect(result.brief.sections.length).toBeGreaterThanOrEqual(3);
    expect(result.brief.metadata.coverage).not.toBeNull();
    expect(result.brief.sources.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5_000);

    // Artifacts + post-mortem state landed in the run dir.
    const runId = result.brief.metadata.run_id!;
    expect(await fileExists(join(runRootDir, runId, 'brief.json'))).toBe(true);
    expect(await fileExists(join(runRootDir, runId, 'brief.md'))).toBe(true);
    expect(await fileExists(join(runRootDir, runId, 'brief.html'))).toBe(true);
    expect(await fileExists(join(runRootDir, runId, 'research-state.json'))).toBe(true);

    const state = JSON.parse(
      await readFile(join(runRootDir, runId, 'research-state.json'), 'utf8'),
    ) as { terminationReason: string | null; hops: unknown[] };
    expect(state.hops.length).toBeGreaterThan(0);
  });

  it('chaos: a search-provider error mid-hop yields a clean partial Brief', async () => {
    const runRootDir = await makeRunRoot();
    // Fail only on hop-2 follow-up queries (not the seed topic).
    const search = new FakeSearch((query) => query !== 'renewable energy grid');
    const loop = makeLoop(runRootDir, { searchProvider: search });

    const result = await loop.run(baseOptions());

    expect(validateBrief(result.brief).isOk).toBe(true);
    // Hop 1 still produced sources; hop 2's failed queries surfaced as notices.
    expect(result.brief.sources.length).toBeGreaterThan(0);
    expect(result.brief.notices.some((n) => n.source === 'search')).toBe(true);
  });

  it('chaos: a fetch-timeout burst degrades every source to a notice, never a hang', async () => {
    const runRootDir = await makeRunRoot();
    const loop = makeLoop(runRootDir, { fetcher: new FakeFetcher({ timeout: true }) });

    const result = await loop.run(
      baseOptions({
        budget: { maxHops: 1, maxSources: 24, maxWallClockMs: 1_000_000, maxLlmCalls: 12 },
      }),
    );

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.brief.sources).toHaveLength(0);
    expect(result.brief.notices.some((n) => n.kind === 'fetch_failed')).toBe(true);
  });

  it('chaos: the wall-clock expiring mid-run stops cleanly with a budget notice', async () => {
    const runRootDir = await makeRunRoot();
    let clock = 0;
    const fetcher = new FakeFetcher({ onFetch: () => (clock += 600) });
    const loop = makeLoop(runRootDir, { fetcher, budgetNow: () => clock });

    const result = await loop.run(
      baseOptions({
        budget: { maxHops: 3, maxSources: 24, maxWallClockMs: 1_000, maxLlmCalls: 12 },
      }),
    );

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.terminationReason).toBe('wall_clock');
    expect(result.brief.notices.some((n) => n.kind === 'budget_exhausted')).toBe(true);
  });

  it('chaos: an unavailable LLM at query-gen falls back to deterministic and still completes', async () => {
    const runRootDir = await makeRunRoot();
    const queryGen = new FollowUpQueryGenerator({
      llm: new UnavailableLlm(),
      prompt: { system: 'S', buildUser: () => 'U' },
    });
    const loop = makeLoop(runRootDir, { queryGen });

    const result = await loop.run(baseOptions());

    expect(validateBrief(result.brief).isOk).toBe(true);
    expect(result.hops).toHaveLength(2);
    // Fell back to deterministic query-gen but still issued novel hop-2 queries.
    expect(result.hops[1]!.queries.length).toBeGreaterThan(0);
  });
});
