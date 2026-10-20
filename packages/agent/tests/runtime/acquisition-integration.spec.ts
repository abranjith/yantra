/**
 * @no-llm The integrated FEAT-050 contract: run-scoped acquisition (TASK-008).
 *
 * A scripted session drives the run's REAL wrapped tools through the default
 * environment composer, with only its leaves replaced: an HTTP transport that
 * counts requests per URL, a browser provider that counts launches, and a
 * search-provider leaf whose provider challenges any search that overlaps
 * another — the G4 pattern. Everything between them (search service, document
 * store, page pool, hybrid fetcher and classifier, budget meter, run health) is
 * production code. Every assertion is made on the finished run.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  BlocklistImpl,
  DEFAULT_SEARCH_CONFIG,
  ScrapeSearchError,
  defaultEthicsConfig,
  resetPathCache,
  type BrowserProvider,
  type BrowserSession,
  type KeychainProvider,
  type SearchProvider,
  type SearchResult,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { ok, type ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditProjectionOf, buildYantraWrappedTools } from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import { runAgenticTask, type EnvironmentLeaves } from '../../src/runtime/orchestrator.js';
import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';

const ORIGIN = 'http://acq.example.test';
const READ_TWICE = `${ORIGIN}/guide`;
const CHALLENGED = `${ORIGIN}/walled`;

const article = (title: string): string =>
  `<!doctype html><html><head><title>${title}</title></head><body><main><article><h1>${title}</h1>` +
  `<p>${'This page is served by the counting transport and is long enough to read. '.repeat(6)}</p>` +
  '</article></main></body></html>';

const CHALLENGE_HTML =
  '<html><head><title>One moment</title></head><body><form action="/verify">' +
  '<h1>Please verify you are human</h1><div data-sitekey="fixture-key"></div>' +
  '<button>Continue</button></form></body></html>';

/** Pair search hits: distinct pages, so the pair shares no read. */
const HITS: Readonly<Record<string, readonly string[]>> = {
  alpha: [`${ORIGIN}/alpha`],
  beta: [`${ORIGIN}/beta`],
  gamma: [`${ORIGIN}/gamma-1`, `${ORIGIN}/gamma-2`, `${ORIGIN}/gamma-3`],
};

/**
 * A `duckduckgo`-named provider that serves an anti-bot challenge whenever a
 * search starts while another is in flight — what scraped providers did to
 * the concurrent pairs in run `20260925T130634Z`.
 */
function challengeOnOverlap(): SearchProvider & {
  readonly peak: () => number;
  readonly challenges: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  let challenges = 0;
  return {
    name: 'duckduckgo',
    peak: () => peak,
    challenges: () => challenges,
    search: async (query): Promise<readonly SearchResult[]> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (inFlight > 1) {
          challenges += 1;
          throw new ScrapeSearchError('challenge', {
            provider: 'duckduckgo',
            code: 'anomaly-challenge',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        const key = Object.keys(HITS).find((word) => query.includes(word)) ?? 'alpha';
        return (HITS[key] ?? []).map((url, index) => ({
          url,
          title: `Result ${index + 1}`,
          snippet: `snippet ${index + 1}`,
          source: 'duckduckgo',
          rank: index + 1,
          publishedAt: null,
        }));
      } finally {
        inFlight -= 1;
      }
    },
  };
}

type Step =
  | { readonly tool: string; readonly params: Record<string, unknown> }
  | {
      readonly parallel: readonly {
        readonly tool: string;
        readonly params: Record<string, unknown>;
      }[];
    };

const SCRIPT: readonly Step[] = [
  {
    parallel: [
      { tool: 'web_search', params: { query: 'alpha listings', limit: 1 } },
      { tool: 'web_search', params: { query: 'beta listings', limit: 1 } },
    ],
  },
  { tool: 'web_search', params: { query: 'gamma listings', limit: 0 } },
  { tool: 'web_fetch', params: { url: READ_TWICE } },
  { tool: 'web_fetch', params: { url: READ_TWICE } },
  { tool: 'web_fetch', params: { url: `${READ_TWICE}#again` } },
  { tool: 'web_fetch', params: { url: CHALLENGED } },
  {
    tool: 'result_publish',
    params: { brief: { title: 'Acquisition run', overview: 'Read what was readable.' } },
  },
];

interface Received {
  readonly tool: string;
  readonly status: string;
  readonly payload: Record<string, unknown>;
}

/** Drives the run's own wrapped tools in script order, a parallel step concurrently. */
class ScriptedProvider implements AgentProvider {
  public readonly results: Received[] = [];

  public constructor(public readonly services: RunServices) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: AgentEvent) => void>();
    let calls = 0;
    const call = async (step: { tool: string; params: Record<string, unknown> }): Promise<void> => {
      const tool = tools.get(step.tool);
      if (tool === undefined) throw new Error(`absent tool ${step.tool}`);
      const callId = `call-${(calls += 1)}`;
      for (const listener of listeners) {
        listener({
          type: 'tool_started',
          callId,
          tool: step.tool,
          input: step.params,
          at: new Date().toISOString(),
        });
      }
      const result = await tool.execute(step.params, undefined);
      for (const listener of listeners) {
        listener({
          type: 'tool_finished',
          callId,
          tool: step.tool,
          output: auditProjectionOf(result),
          isError: result.status !== 'ok',
          at: new Date().toISOString(),
        });
      }
      this.results.push({
        tool: step.tool,
        status: result.status,
        payload: JSON.parse(result.modelText) as Record<string, unknown>,
      });
    };
    const session: AgentSession = {
      id: 'acquisition-session',
      logPath: `${options.runDir}/agent/acquisition-session.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      steer: () => Promise.resolve('idle'),
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        for (const step of SCRIPT) {
          if ('parallel' in step) await Promise.all(step.parallel.map(call));
          else await call(step);
        }
        return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
      },
    };
    return Promise.resolve(session);
  }
}

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;
  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'granted'> {
    return Promise.resolve('granted');
  }
  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Progress rendering is not what this contract asserts.
  }
  public renderAgentOutcome(): void {
    // The outcome is returned directly.
  }
}

function memoryKeychain(): KeychainProvider {
  return {
    get: () => Promise.resolve(null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    isAvailable: () => Promise.resolve(true),
  };
}

/** A browser provider standing in for Chrome: every page it renders is the challenge. */
function countingBrowser(): {
  readonly provider: BrowserProvider;
  readonly launches: () => number;
} {
  let launches = 0;
  const page = () => {
    let at = 'about:blank';
    return {
      goto: (url: string) => {
        at = url;
        return Promise.resolve({ status: () => 200 });
      },
      evaluate: () => Promise.resolve(CHALLENGE_HTML),
      url: () => at,
      close: () => Promise.resolve(),
      on: () => undefined,
    };
  };
  return {
    launches: () => launches,
    provider: {
      launch: () => {
        launches += 1;
        return Promise.resolve({
          id: `session-${launches}`,
          profilePath: '',
          newPage: () => Promise.resolve(page()),
          newIsolatedPage: () => Promise.resolve(page()),
          close: () => Promise.resolve(),
          on: () => undefined,
        } as unknown as BrowserSession);
      },
      detectChrome: () => Promise.resolve(null),
    },
  };
}

function jsonl(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('@no-llm FEAT-050 integrated contract — run-scoped acquisition', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-acquisition-'));
    previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = join(root, 'home');
    resetPathCache();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previousHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  it('reads once, searches politely, stops at a challenge, and says so in every artifact', async () => {
    const requests: string[] = [];
    const httpRequestFn = ((url: string) => {
      requests.push(String(url));
      const challenged = String(url) === CHALLENGED;
      return Promise.resolve({
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: Readable.from([
          Buffer.from(challenged ? CHALLENGE_HTML : article(String(url)), 'utf8'),
        ]),
      });
    }) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;
    const browser = countingBrowser();
    const provider = challengeOnOverlap();
    let resolutions = 0;
    const resolveSearchProvider = ((options: {
      readonly deps: { readonly logger: { info: (obj: object, msg: string) => void } };
    }) => {
      resolutions += 1;
      // As the production resolver logs on success.
      options.deps.logger.info({ provider: 'duckduckgo', via: 'auto' }, 'selected search provider');
      return Promise.resolve(ok(provider));
    }) as unknown as EnvironmentLeaves['resolveSearchProvider'];
    let driver: ScriptedProvider | undefined;

    const outcome = await runAgenticTask(
      {
        goal: `Survey the acquisition fixture site, including ${READ_TWICE} and ${CHALLENGED}, and report what could be read`,
        profile: COMMAND_TASK_PROFILES.research,
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
      },
      {
        runStore: new LocalRunStore(join(root, 'runs')),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        environmentLeaves: {
          keychain: memoryKeychain(),
          ethicsConfig: defaultEthicsConfig,
          searchConfig: DEFAULT_SEARCH_CONFIG,
          blocklist: new BlocklistImpl(),
          createBrowserProvider: () => browser.provider,
          httpRequestFn,
          resolveSearchProvider,
        },
        createProvider: (services) => {
          driver = new ScriptedProvider(services);
          return driver;
        },
      },
    );
    if (driver === undefined) throw new Error('the run never created its provider');
    const results = driver.results;
    const byTool = (tool: string): Received[] => results.filter((result) => result.tool === tool);

    expect(outcome.kind).toBe('published');

    // G4: the concurrent pair was serialized — no overlap, no challenge.
    expect(provider.peak()).toBe(1);
    expect(provider.challenges()).toBe(0);
    expect(
      byTool('web_search')
        .slice(0, 2)
        .map((result) => result.status),
    ).toEqual(['ok', 'ok']);

    // Discovery: no page read, no navigation charged.
    const [, , discovery] = byTool('web_search');
    const beforeDiscovery = (byTool('web_search')[1]?.payload.budget as { navigations: string })
      .navigations;
    expect(discovery?.payload).toMatchObject({ mode: 'discovery' });
    expect((discovery?.payload.budget as { navigations: string }).navigations).toBe(
      beforeDiscovery,
    );
    for (const url of HITS.gamma ?? []) expect(requests).not.toContain(url);

    // G5: three reads of one page, one request; repeats are already_read.
    expect(requests.filter((url) => url === READ_TWICE)).toHaveLength(1);
    const [firstRead, secondRead, thirdRead, challenged] = byTool('web_fetch');
    const readId = firstRead?.payload.source_id;
    expect(typeof readId).toBe('string');
    expect(secondRead?.payload).toMatchObject({ already_read: readId });
    expect(thirdRead?.payload).toMatchObject({ already_read: readId });

    // G10: the challenge is blocked at both tiers, never a source.
    expect(challenged?.payload).toMatchObject({ error_code: 'SITE_CHALLENGE' });
    expect(requests.filter((url) => url === CHALLENGED)).toHaveLength(1);
    const evidence = driver.services.evidence.entries();
    expect(evidence.map((entry) => entry.url)).not.toContain(CHALLENGED);
    const brief = JSON.parse(await readFile(join(outcome.runDir, 'brief.json'), 'utf8')) as {
      readonly notices: readonly { readonly kind: string; readonly source: string }[];
    };
    expect(brief.notices).toContainEqual(
      expect.objectContaining({ kind: 'blocked', source: 'acq.example.test' }),
    );
    const runtime = jsonl(await readFile(join(outcome.runDir, 'runtime.jsonl'), 'utf8'));
    expect(
      runtime
        .filter((line) => line.event === 'fetch_challenge')
        .map((line) => [line.level, line.tier]),
    ).toEqual([
      [40, 'http'],
      [40, 'browser'],
    ]);

    // One provider resolution for the whole run.
    expect(resolutions).toBe(1);
    expect(runtime.filter((line) => line.msg === 'selected search provider')).toHaveLength(1);

    // Run health tells the same story.
    const health = JSON.parse(await readFile(join(outcome.runDir, 'run-health.json'), 'utf8')) as {
      readonly fetches: Record<string, unknown>;
      readonly browser: Record<string, number>;
      readonly searches: Record<string, unknown>;
    };
    expect(health.fetches).toMatchObject({ cache_hits: 2, challenges: { http: 1, browser: 1 } });
    expect(health.browser.pool_launches ?? 0).toBeLessThanOrEqual(1);
    expect(browser.launches()).toBeLessThanOrEqual(1);
    expect(health.searches).toMatchObject({ peak_concurrency: 1, breaker_skipped: 0 });

    // Every audit line parses.
    const toolCalls = jsonl(await readFile(join(outcome.runDir, 'tool-calls.jsonl'), 'utf8'));
    expect(toolCalls.length).toBeGreaterThan(0);

    // The IDs the model saw are the IDs the ledger holds.
    const shown = new Set<string>();
    for (const result of results) {
      const id = result.payload.source_id;
      if (typeof id === 'string' && result.payload.already_read === undefined) shown.add(id);
      for (const site of (result.payload.sites as { source_id?: string }[] | undefined) ?? []) {
        if (typeof site.source_id === 'string') shown.add(site.source_id);
      }
    }
    expect([...shown].sort()).toEqual(
      evidence
        .map((entry) => entry.sourceId)
        .filter((id): id is string => id !== null)
        .sort(),
    );
  }, 60_000);
});
