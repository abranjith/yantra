// @no-llm
/**
 * Deterministic `ask` records its phases in `run-events.jsonl` (FEAT-063
 * TASK-008): search, one fetch result per source, extraction, synthesis, the
 * Brief files and exactly one final outcome — gap-free, and with nothing from
 * the query that the run-input redactor would hide.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Brief, RunEventRecordType } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { AskPipeline } from '../../src/extraction/ask-pipeline.js';
import type { AskCache } from '../../src/extraction/cache.js';
import type { AskQuery, FetchedDoc, SearchResult } from '../../src/extraction/types.js';
import { readRunEvents } from '../../src/run-events/reader.js';
import { RunEventStream } from '../../src/run-events/stream.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';

const CANARY = 'sk-CANARY0123456789abcdefghijklmn';
const FIXED = '2026-06-15T00:00:00.000Z';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const TEXT: Record<string, string> = {
  one: 'AI news this week centered on a major research lab that released a new language model. The team reported improved reasoning accuracy by twelve percent.',
  two: 'In AI news, a startup raised forty-five million dollars to expand its coding assistant. The company said its model automates enterprise workflows.',
  three:
    'Chipmakers unveiled faster processors built for AI model training. One vendor listed its flagship accelerator at 328 dollars.',
};
const rows: SearchResult[] = ['one', 'two', 'three', 'blocked'].map((id, rank) => ({
  url: `https://user:pw@example.com/${id}?session=${CANARY}#frag`,
  title: id,
  snippet: id,
  source: 'duckduckgo',
  rank,
  publishedAt: null,
}));
const idOf = (url: string): string => new URL(url).pathname.slice(1);

class MemoryCache implements AskCache {
  public readonly store = new Map<string, Brief>();
  public get(key: string): Promise<Brief | null> {
    return Promise.resolve(this.store.get(key) ?? null);
  }
  public put(key: string, brief: Brief): Promise<void> {
    this.store.set(key, brief);
    return Promise.resolve();
  }
  public delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

async function pipeline(cache: AskCache = new MemoryCache()) {
  const root = await mkdtemp(join(tmpdir(), 'yantra-ask-events-'));
  dirs.push(root);
  const ask = new AskPipeline({
    searchProvider: { name: 'duckduckgo', search: () => Promise.resolve(rows) },
    fetcher: {
      fetch: (url: string): Promise<FetchedDoc> => {
        if (idOf(url) === 'three') return Promise.reject(new Error('connection reset'));
        return Promise.resolve({
          url,
          finalUrl: url,
          fetchedAt: FIXED,
          contentType: 'text/html',
          html: `<p>${TEXT[idOf(url)] ?? ''}</p>`,
          statusCode: 200,
          fetchMode: 'http',
          elapsedMs: 5,
        });
      },
    },
    extractor: {
      extract: (doc: FetchedDoc) =>
        Promise.resolve({
          url: doc.finalUrl,
          title: idOf(doc.finalUrl),
          byline: null,
          publishedAt: null,
          siteName: 'example.com',
          contentText: TEXT[idOf(doc.finalUrl)] ?? '',
          contentHtml: '',
          excerpt: '',
          lengthChars: 10,
        }),
    },
    cache,
    ethicsGate: {
      checkUrl: (url: string) =>
        Promise.resolve(
          idOf(url) === 'blocked'
            ? { ok: false as const, reason: 'robots' as const, detail: 'disallowed' }
            : { ok: true as const },
        ),
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runRootDir: root,
    synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
    clock: () => new Date(FIXED),
  });
  return { root, ask };
}

const query: AskQuery = {
  raw: `ai news ${CANARY}`,
  normalized: `ai news ${CANARY}`,
  limit: 3,
  noCache: false,
  noLlm: true,
  budgetCalls: null,
  searchProvider: null,
  perFetchTimeoutMs: 8_000,
  pipelineBudgetMs: 30_000,
  length: 'medium',
};

async function onlyRun(root: string): Promise<string> {
  const [runId] = await readdir(root);
  return join(root, runId!);
}

async function records(runDir: string): Promise<RunEventRecordType[]> {
  const out: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(runDir, 'run-events.jsonl'))) {
    if (item.status !== 'event') throw new Error(`unexpected ${item.status}`);
    out.push(item.record);
  }
  return out;
}

const phaseKinds = new Set([
  'search_completed',
  'source_fetched',
  'extract_completed',
  'synthesize_started',
  'synthesis_completed',
  'artifact_saved',
  'run_outcome',
]);

describe('@no-llm ask run-events.jsonl', () => {
  it('records the phases in order, one source_fetched per source, and one final outcome', async () => {
    const { root, ask } = await pipeline();
    await ask.run(query);
    const rs = await records(await onlyRun(root));
    const phases = rs.map((r) => r.event.kind).filter((k) => phaseKinds.has(k));

    expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i + 1));
    expect(phases).toEqual([
      'search_completed',
      'source_fetched',
      'source_fetched',
      'source_fetched',
      'source_fetched',
      'extract_completed',
      'synthesize_started',
      'synthesis_completed',
      'artifact_saved',
      'artifact_saved',
      'artifact_saved',
      'run_outcome',
    ]);
    expect(rs.at(-1)?.event).toMatchObject({
      kind: 'run_outcome',
      task_outcome: 'partial',
      exit_code: 0,
      termination_reason: null,
      stop_detail: null,
      failure_class: null,
    });
    expect(rs.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
  });

  it('reports each source’s status, with a blocked source as blocked', async () => {
    const { root, ask } = await pipeline();
    await ask.run(query);
    const fetched = (await records(await onlyRun(root)))
      .filter((r) => r.event.kind === 'source_fetched')
      .map(
        (r) =>
          r.event as {
            source_index: number;
            status: string;
            url: string;
            failure_class: string | null;
          },
      )
      .sort((a, b) => a.source_index - b.source_index);

    expect(fetched.map((f) => [f.source_index, f.status, f.failure_class])).toEqual([
      [1, 'ok', null],
      [2, 'ok', null],
      [3, 'failed', 'fetch'],
      [4, 'blocked', 'blocked'],
    ]);
    expect(fetched[0]?.url).toBe('https://example.com/one');
  });

  it('records the search with its provider, bounded query and result count', async () => {
    const { root, ask } = await pipeline();
    await ask.run(query);
    const search = (await records(await onlyRun(root))).find(
      (r) => r.event.kind === 'search_completed',
    );

    expect(search?.event).toMatchObject({
      hop_index: null,
      provider: 'duckduckgo',
      query: 'ai news {{user:api_key:1}}',
      result_count: 4,
      cached: false,
    });
  });

  it('never writes the canary credential into the log bytes', async () => {
    const { root, ask } = await pipeline();
    await ask.run(query);
    const bytes = readFileSync(join(await onlyRun(root), 'run-events.jsonl'), 'utf8');

    expect(bytes).not.toContain(CANARY);
    expect(bytes).not.toContain('user:pw');
    expect(bytes).not.toContain('#frag');
  });

  it('records a cache hit as a cached search with the Brief files and an outcome', async () => {
    const cache = new MemoryCache();
    const first = await pipeline(cache);
    await first.ask.run(query);
    const second = await pipeline(cache);
    await second.ask.run(query);
    const rs = await records(await onlyRun(second.root));

    expect(rs.find((r) => r.event.kind === 'search_completed')?.event).toMatchObject({
      cached: true,
    });
    expect(rs.some((r) => r.event.kind === 'source_fetched')).toBe(false);
    expect(rs.filter((r) => r.event.kind === 'artifact_saved')).toHaveLength(3);
    expect(rs.at(-1)?.event.kind).toBe('run_outcome');
  });

  it('commits a caller’s stream and closes it after the outcome', async () => {
    const { root, ask } = await pipeline();
    const stream = new RunEventStream();
    const seen: string[] = [];
    stream.subscribe((d) => seen.push(d.event.kind), { includeUncommitted: true });
    stream.emit({
      kind: 'goal_echo',
      display: 'goal: "ai news"',
      received_chars: 7,
      truncated: false,
      at: FIXED,
    });

    await ask.run({ ...query, runEvents: stream });
    const rs = await records(await onlyRun(root));

    expect(rs[0]?.event.kind).toBe('goal_echo');
    expect(seen).toEqual(rs.map((r) => r.event.kind));
    expect(stream.closed).toBe(true);
  });

  it('a failed run ends with task_failed and, for an owned stream, a failed outcome', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-ask-events-'));
    dirs.push(root);
    const failing = new AskPipeline({
      searchProvider: {
        name: 'duckduckgo',
        search: () => Promise.reject(new Error('search down')),
      },
      fetcher: { fetch: () => Promise.reject(new Error('unused')) },
      extractor: { extract: () => Promise.reject(new Error('unused')) },
      cache: new MemoryCache(),
      ethicsGate: { checkUrl: () => Promise.resolve({ ok: true as const }) },
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
      runRootDir: root,
      synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
    });

    await expect(failing.run({ ...query, noCache: true })).rejects.toThrow('search down');
    const rs = await records(await onlyRun(root));

    expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i + 1));
    expect(rs.map((r) => r.event.kind).slice(-2)).toEqual(['task_failed', 'run_outcome']);
    expect(rs.at(-1)?.event).toMatchObject({
      task_outcome: 'failed',
      exit_code: 2,
      failure_class: 'unexpected',
    });
  });
});
