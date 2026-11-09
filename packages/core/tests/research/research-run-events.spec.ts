// @no-llm
/**
 * Deterministic `research` records each hop's phases, a budget snapshot after
 * every hop, and one final outcome whose `stop_detail` says why the loop
 * stopped (FEAT-063 TASK-008).
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunEventRecordType } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { FetchedDoc, SearchResult } from '../../src/extraction/types.js';
import { FollowUpQueryGenerator } from '../../src/research/query-gen.js';
import { ResearchLoop } from '../../src/research/research-loop.js';
import type { ResearchOptions } from '../../src/research/types.js';
import { readRunEvents } from '../../src/run-events/reader.js';
import { DeterministicSynthesizer } from '../../src/synthesis/deterministic.js';

const CANARY = 'sk-CANARY0123456789abcdefghijklmn';
const FIXED = '2026-06-15T00:00:00.000Z';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

let searchCount = 0;
function rowsFor(query: string): SearchResult[] {
  searchCount += 1;
  const base = query.replace(/\W+/gu, '-').slice(0, 20);
  return [1, 2].map((n) => ({
    url: `https://example.com/${base}-${searchCount}-${n}?k=${CANARY}`,
    title: `${query} ${n}`,
    snippet: query,
    source: 'duckduckgo',
    rank: n - 1,
    publishedAt: null,
  }));
}

const article = (seed: string): string =>
  `Electric vehicles in ${seed} saw battery prices fall while charging networks expanded across regions. Analysts tracked ${seed} adoption figures and policy incentives for buyers.`;

async function loop() {
  const root = await mkdtemp(join(tmpdir(), 'yantra-research-events-'));
  dirs.push(root);
  searchCount = 0;
  const research = new ResearchLoop({
    searchProvider: { name: 'duckduckgo', search: (q: string) => Promise.resolve(rowsFor(q)) },
    fetcher: {
      fetch: (url: string): Promise<FetchedDoc> =>
        Promise.resolve({
          url,
          finalUrl: url,
          fetchedAt: FIXED,
          contentType: 'text/html',
          html: `<p>${article(url)}</p>`,
          statusCode: 200,
          fetchMode: 'http',
          elapsedMs: 5,
        }),
    },
    extractor: {
      extract: (doc: FetchedDoc) =>
        Promise.resolve({
          url: doc.finalUrl,
          title: doc.finalUrl,
          byline: null,
          publishedAt: null,
          siteName: 'example.com',
          contentText: article(new URL(doc.finalUrl).pathname),
          contentHtml: '',
          excerpt: '',
          lengthChars: 100,
        }),
    },
    ethicsGate: { checkUrl: () => Promise.resolve({ ok: true as const }) },
    synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
    queryGen: new FollowUpQueryGenerator(),
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    runRootDir: root,
    clock: () => new Date(FIXED),
    budgetNow: () => 0,
  });
  return { root, research };
}

const options: ResearchOptions = {
  topic: `electric vehicles ${CANARY}`,
  budget: { maxHops: 2, maxSources: 24, maxWallClockMs: 60_000, maxLlmCalls: 4 },
  noLlm: true,
  length: 'medium',
  scope: 'public',
  perQueryLimit: 2,
  perFetchTimeoutMs: 5_000,
  coverageTarget: 1.1,
};

async function records(root: string): Promise<RunEventRecordType[]> {
  const [runId] = await readdir(root);
  const out: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(root, runId!, 'run-events.jsonl'))) {
    if (item.status !== 'event') throw new Error(`unexpected ${item.status}`);
    out.push(item.record);
  }
  return out;
}

describe('@no-llm research run-events.jsonl', () => {
  it('records every hop’s phases with its hop index, then a budget snapshot', async () => {
    const { root, research } = await loop();
    const result = await research.run(options);
    const rs = await records(root);
    const hops = result.hops.length;

    expect(hops).toBeGreaterThanOrEqual(1);
    for (let hop = 1; hop <= hops; hop++) {
      const own = rs.filter(
        (r) =>
          r.event.kind !== 'research_hop_completed' &&
          (r.event as { hop_index?: number | null }).hop_index === hop,
      );
      const kinds = own.map((r) => r.event.kind);
      expect(kinds).toContain('search_completed');
      expect(kinds).toContain('source_fetched');
      expect(kinds.at(-1)).toBe('extract_completed');
    }
    const snapshots = rs.filter((r) => r.event.kind === 'budget_snapshot');
    expect(snapshots).toHaveLength(hops);
    expect(snapshots.at(-1)?.event).toMatchObject({
      dimensions: expect.arrayContaining([{ name: 'hops', used: hops, limit: 2, unit: 'count' }]),
    });
  });

  it('puts each budget snapshot right after its hop’s extraction', async () => {
    const { root, research } = await loop();
    await research.run(options);
    const kinds = (await records(root)).map((r) => r.event.kind);

    kinds.forEach((kind, index) => {
      if (kind === 'budget_snapshot') expect(kinds[index - 1]).toBe('extract_completed');
    });
  });

  it('ends with one outcome whose stop_detail is the termination reason', async () => {
    const { root, research } = await loop();
    const result = await research.run(options);
    const rs = await records(root);

    expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i + 1));
    expect(rs.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
    expect(rs.at(-1)?.event).toMatchObject({
      kind: 'run_outcome',
      stop_detail: result.terminationReason,
      exit_code: 0,
      termination_reason: null,
    });
    const tail = rs.map((r) => r.event.kind).slice(-6);
    expect(tail).toEqual([
      'synthesis_completed',
      'artifact_saved',
      'artifact_saved',
      'artifact_saved',
      'task_completed',
      'run_outcome',
    ]);
    expect(rs.map((r) => r.event.kind)).toContain('synthesize_started');
  });

  it('never writes the canary credential into the log bytes, not even in mirrored hop queries', async () => {
    const { root, research } = await loop();
    await research.run(options);
    const [runId] = await readdir(root);
    const bytes = readFileSync(join(root, runId!, 'run-events.jsonl'), 'utf8');

    expect(bytes).not.toContain(CANARY);
    expect(bytes).toContain('research_hop_completed');
  });
});
