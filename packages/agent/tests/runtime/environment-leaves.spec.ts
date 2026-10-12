/**
 * @no-llm The default environment's leaf seam (FEAT-049 TASK-003).
 *
 * `environmentLeaves` lets an embedder replace what the default environment is
 * built FROM — the keychain, loaded configuration, the browser factory, the
 * HTTP transport, the search-provider resolver — while the composition on top
 * (ethics gate, hybrid fetcher, browser controller, launch counter, publisher)
 * stays production code. These tests drive real runs through the real composer
 * with only those leaves replaced, and read what the run did from its tools'
 * results and its artifacts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import {
  BlocklistImpl,
  DEFAULT_SEARCH_CONFIG,
  ReadabilityExtractor,
  ScriptRegistry,
  createSelectedBrowserProvider,
  defaultEthicsConfig,
  loadEthicsConfig,
  loadSearchConfig,
  resetPathCache,
  resolveSearchProvider,
  type BrowserProvider,
  type BrowserSession,
  type KeychainProvider,
  type SearchProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { generateUlid, ok, type ConfirmationRequest } from '@yantra/protocol';
import { assertRuntimeEventIsSafe } from '@yantra/test-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditProjectionOf,
  buildYantraWrappedTools,
  createBriefPublisher,
} from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import {
  defaultEnvironmentLeaves,
  runAgenticTask,
  type AgenticRunEnvironment,
  type EnvironmentLeaves,
} from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import { COMMAND_TASK_PROFILES } from '../../src/runtime/profiles.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { searchServiceFor } from '../adapters/pi/tools/test-support.js';

const PAGE_URL = 'http://leaf.example.test/article';
const SECOND_URL = 'http://leaf.example.test/second';
const ARTICLE_HTML =
  '<!doctype html><html><head><title>Leaf article</title></head><body><main><article>' +
  '<h1>Leaf article</h1>' +
  '<p>This article is served by the injected HTTP transport. It is long enough for the ' +
  'readability extractor to treat it as the main content of the page, which is what the ' +
  'default web_fetch path requires before it records a source.</p>' +
  '<p>A second paragraph keeps the content comfortably above the extraction threshold so ' +
  'the result is an ordinary successful article read.</p>' +
  '</article></main></body></html>';

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;
  public readonly outcomes: AgenticTaskOutcome[] = [];

  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'granted'> {
    return Promise.resolve('granted');
  }

  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Progress rendering is not what these tests assert.
  }

  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    this.outcomes.push(outcome);
  }
}

interface Step {
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

/** Drives the run's own wrapped tools: the plan on the first prompt, a publish after. */
class ScriptedProvider implements AgentProvider {
  public readonly results: {
    readonly tool: string;
    readonly status: string;
    readonly modelText: string;
  }[] = [];
  /** The tool currently executing, so a fake browser can attribute its launches. */
  public current = '';

  public constructor(
    private readonly services: RunServices,
    private readonly plan: readonly Step[],
  ) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => {
      for (const listener of listeners) listener(event);
    };
    let runs = 0;
    let calls = 0;
    const session: AgentSession = {
      id: 'leaf-session',
      logPath: `${options.runDir}/agent/leaf-session.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        const steps: readonly Step[] =
          runs++ === 0
            ? this.plan
            : [
                {
                  tool: 'result_publish',
                  params: { brief: { title: 'Leaf result', overview: 'The leaf run completed.' } },
                },
              ];
        for (const step of steps) {
          const tool = tools.get(step.tool);
          if (tool === undefined) throw new Error(`absent tool ${step.tool}`);
          this.current = step.tool;
          const callId = `call-${(calls += 1)}`;
          emit({
            type: 'tool_started',
            callId,
            tool: step.tool,
            input: step.params,
            at: new Date().toISOString(),
          });
          const result = await tool.execute(step.params, undefined);
          // The orchestrator learns a run published from this event, exactly
          // as it does from a real session.
          emit({
            type: 'tool_finished',
            callId,
            tool: step.tool,
            output: auditProjectionOf(result),
            isError: result.status !== 'ok',
            at: new Date().toISOString(),
          });
          this.results.push({
            tool: step.tool,
            status: result.status,
            modelText: result.modelText,
          });
        }
        this.current = '';
        return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
      },
    };
    return Promise.resolve(session);
  }
}

/** A browser provider standing in for Chrome: records which tool launched it. */
function fakeBrowser(attribute: () => string): {
  readonly provider: BrowserProvider;
  readonly launches: string[];
} {
  const launches: string[] = [];
  const page = {
    goto: () => Promise.resolve({ status: () => 200 }),
    evaluate: () => Promise.resolve(ARTICLE_HTML),
    url: () => PAGE_URL,
    close: () => Promise.resolve(),
    on: () => undefined,
  };
  const session = {
    id: 'fake-session',
    profilePath: '',
    newPage: () => Promise.resolve(page),
    newIsolatedPage: () => Promise.resolve(page),
    close: () => Promise.resolve(),
    on: () => undefined,
  } as unknown as BrowserSession;
  return {
    launches,
    provider: {
      launch: () => {
        launches.push(attribute());
        return Promise.resolve(session);
      },
      detectChrome: () => Promise.resolve(null),
    },
  };
}

/** An in-memory keychain: the real one is never loaded by these tests. */
function memoryKeychain(): KeychainProvider {
  const values = new Map<string, string>();
  return {
    get: (service, account) => Promise.resolve(values.get(`${service}/${account}`) ?? null),
    set: (service, account, value) => {
      values.set(`${service}/${account}`, value);
      return Promise.resolve();
    },
    delete: (service, account) => Promise.resolve(values.delete(`${service}/${account}`)),
    list: () => Promise.resolve([]),
    isAvailable: () => Promise.resolve(true),
  };
}

/** An undici-shaped response serving `html` with `status`. */
function httpResponse(status: number, html: string): unknown {
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: Readable.from([Buffer.from(html, 'utf8')]),
  };
}

/** True when any run directory under `runsRoot` already holds `run-health.json`. */
function runHealthExists(runsRoot: string): boolean {
  if (!existsSync(runsRoot)) return false;
  return readdirSync(runsRoot, { recursive: true, encoding: 'utf8' }).some((entry) =>
    entry.endsWith('run-health.json'),
  );
}

function hermeticLeaves(overrides: Partial<EnvironmentLeaves> = {}): Partial<EnvironmentLeaves> {
  return {
    keychain: memoryKeychain(),
    ethicsConfig: defaultEthicsConfig,
    searchConfig: DEFAULT_SEARCH_CONFIG,
    blocklist: new BlocklistImpl(),
    ...overrides,
  };
}

describe('@no-llm environment leaves', () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-environment-leaves-'));
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

  async function run(input: {
    readonly leaves: Partial<EnvironmentLeaves>;
    readonly plan: readonly Step[];
    readonly createEnvironment?: (context: {
      readonly runId: string;
      readonly runDir: string;
    }) => Promise<AgenticRunEnvironment>;
    readonly profile?: keyof typeof COMMAND_TASK_PROFILES;
    /** Receives the driver as soon as the run creates it. */
    readonly holder?: { driver?: ScriptedProvider };
  }): Promise<{ readonly outcome: AgenticTaskOutcome; readonly driver: ScriptedProvider }> {
    let driver: ScriptedProvider | undefined;
    const outcome = await runAgenticTask(
      {
        goal: `Read the leaf articles at ${PAGE_URL} and ${SECOND_URL} and report them`,
        profile: COMMAND_TASK_PROFILES[input.profile ?? 'do'],
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
      },
      {
        runStore: new LocalRunStore(join(root, 'runs')),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        environmentLeaves: input.leaves,
        ...(input.createEnvironment ? { createEnvironment: input.createEnvironment } : {}),
        createProvider: (services) => {
          driver = new ScriptedProvider(services, input.plan);
          if (input.holder) input.holder.driver = driver;
          return driver;
        },
      },
    );
    if (driver === undefined) throw new Error('the run never created its provider');
    return { outcome, driver };
  }

  it('builds today’s production leaves for everything not overridden', async () => {
    const leaves = await defaultEnvironmentLeaves({ keychain: memoryKeychain() });

    expect(leaves.createBrowserProvider).toBe(createSelectedBrowserProvider);
    expect(leaves.resolveSearchProvider).toBe(resolveSearchProvider);
    expect(leaves.ethicsConfig).toEqual(await loadEthicsConfig());
    expect(leaves.searchConfig).toEqual(await loadSearchConfig());
    expect(leaves.blocklist).toBeInstanceOf(BlocklistImpl);
    expect(leaves).not.toHaveProperty('httpRequestFn');
  });

  it('returns every override as given, building no default for it', async () => {
    const overrides: EnvironmentLeaves = {
      keychain: memoryKeychain(),
      ethicsConfig: { ...defaultEthicsConfig, userAgent: 'LeafBot/1' },
      searchConfig: { ...DEFAULT_SEARCH_CONFIG, fetchTop: 1 },
      blocklist: new BlocklistImpl(),
      createBrowserProvider: () => fakeBrowser(() => '').provider,
      httpRequestFn: vi.fn() as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>,
      resolveSearchProvider: () => Promise.reject(new Error('unused')),
    };

    const leaves = await defaultEnvironmentLeaves(overrides);

    expect(Object.keys(leaves).sort()).toEqual(Object.keys(overrides).sort());
    for (const key of Object.keys(overrides) as (keyof EnvironmentLeaves)[]) {
      expect(leaves[key]).toBe(overrides[key]);
    }
  });

  it('routes web_search through the resolveSearchProvider leaf and page reads through httpRequestFn', async () => {
    const searched: string[] = [];
    const provider: SearchProvider = {
      name: 'duckduckgo',
      search: (query) => {
        searched.push(query);
        return Promise.resolve([
          {
            url: PAGE_URL,
            title: 'Leaf',
            snippet: null,
            source: 'duckduckgo',
            rank: 1,
            publishedAt: null,
          },
        ]);
      },
    };
    const resolver = vi.fn(() => Promise.resolve(ok(provider)));
    const requested: string[] = [];
    const httpRequestFn = vi.fn((url: string) => {
      requested.push(String(url));
      return Promise.resolve(httpResponse(200, ARTICLE_HTML));
    }) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;

    const { outcome, driver } = await run({
      leaves: hermeticLeaves({ resolveSearchProvider: resolver, httpRequestFn }),
      plan: [
        { tool: 'web_search', params: { query: 'leaf article', limit: 1 } },
        { tool: 'web_fetch', params: { url: PAGE_URL } },
      ],
      profile: 'research',
    });

    expect(outcome.kind).toBe('published');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(searched).toEqual(['leaf article']);
    // One read, inline from the search: the run document store answers the
    // later web_fetch of the same page without a second request (FEAT-050).
    expect(requested).toEqual([PAGE_URL]);
    expect(driver.results.map((result) => [result.tool, result.status])).toEqual([
      ['web_search', 'ok'],
      ['web_fetch', 'ok'],
      ['result_publish', 'ok'],
    ]);
    expect(driver.results[0]?.modelText).toContain('served by the injected HTTP transport');
    expect(JSON.parse(driver.results[1]?.modelText ?? '{}')).toMatchObject({
      already_read: 'S1',
    });
  });

  it('gives the resolver the run’s own deps, with the run’s search config', async () => {
    const resolver = vi.fn(() =>
      Promise.resolve(
        ok<SearchProvider>({ name: 'duckduckgo', search: () => Promise.resolve([]) }),
      ),
    );
    const searchConfig = { ...DEFAULT_SEARCH_CONFIG, fetchTop: 2 };

    await run({
      leaves: hermeticLeaves({ resolveSearchProvider: resolver, searchConfig }),
      plan: [{ tool: 'web_search', params: { query: 'anything' } }],
      profile: 'research',
    });

    const [options] = resolver.mock.calls[0] as unknown as [
      { readonly config: unknown; readonly deps: Record<string, unknown> },
    ];
    expect(options.config).toBe(searchConfig);
    expect(Object.keys(options.deps).sort()).toEqual(['ethicsGate', 'keychain', 'logger', 'pages']);
  });

  it('uses one createBrowserProvider for the controller, the fetch fallback, and the scrape transport', async () => {
    const holder: { driver?: ScriptedProvider } = {};
    const browser = fakeBrowser(() => holder.driver?.current ?? '');
    const createBrowserProvider = vi.fn(() => browser.provider);
    // HTTP refuses the bot user agent, which is what escalates a read to the browser.
    const httpRequestFn = vi.fn(() =>
      Promise.resolve(httpResponse(403, 'forbidden')),
    ) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;

    const result = await run({
      leaves: hermeticLeaves({
        createBrowserProvider,
        httpRequestFn,
        // The production resolver, pinned to the scraped provider, so the
        // search launches its SERP browser through the run's shared provider.
        searchConfig: { ...DEFAULT_SEARCH_CONFIG, provider: 'duckduckgo' },
      }),
      plan: [
        { tool: 'web_fetch', params: { url: PAGE_URL } },
        { tool: 'web_search', params: { query: 'leaf article', limit: 1 } },
        { tool: 'browser_navigate', params: { url: PAGE_URL } },
      ],
      holder,
    });

    expect(createBrowserProvider).toHaveBeenCalledTimes(1);
    // Two processes, not three (FEAT-050): the fetch fallback launched the
    // run's page pool, the SERP scrape reused it in its own context, and the
    // task browser launched separately for browser_navigate.
    expect(browser.launches).toEqual(['web_fetch', 'browser_navigate']);
    const health = JSON.parse(
      await readFile(join(result.outcome.runDir, 'run-health.json'), 'utf8'),
    ) as {
      readonly browser: {
        readonly launches: number;
        readonly pool_launches?: number;
        readonly contexts?: number;
      };
    };
    expect(health.browser).toEqual({ launches: 2, pool_launches: 1, contexts: 2 });
  });

  it('shares one page pool across scraped searches and escalated fetches, and closes it before run health', async () => {
    const holder: { driver?: ScriptedProvider } = {};
    const closes: { readonly tool: string; readonly runHealthWritten: boolean }[] = [];
    const launchedBy: string[] = [];
    let contexts = 0;
    const page = (): { goto: (url: string) => Promise<unknown>; [key: string]: unknown } => {
      let at = 'about:blank';
      return {
        goto: (url: string) => {
          at = url;
          return Promise.resolve({ status: () => 200 });
        },
        evaluate: () => Promise.resolve(ARTICLE_HTML),
        url: () => at,
        close: () => Promise.resolve(),
        on: () => undefined,
      };
    };
    const provider: BrowserProvider = {
      launch: () => {
        const tool = holder.driver?.current ?? '';
        launchedBy.push(tool);
        return Promise.resolve({
          id: `session-${launchedBy.length}`,
          profilePath: '',
          newPage: () => Promise.resolve(page()),
          newIsolatedPage: () => {
            contexts += 1;
            return Promise.resolve(page());
          },
          close: () => {
            closes.push({ tool, runHealthWritten: runHealthExists(join(root, 'runs')) });
            return Promise.resolve();
          },
          on: () => undefined,
        } as unknown as BrowserSession);
      },
      detectChrome: () => Promise.resolve(null),
    };
    // HTTP refuses the bot user agent, so every page read escalates to a render.
    const httpRequestFn = vi.fn(() =>
      Promise.resolve(httpResponse(403, 'forbidden')),
    ) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;

    const result = await run({
      leaves: hermeticLeaves({
        createBrowserProvider: () => provider,
        httpRequestFn,
        searchConfig: { ...DEFAULT_SEARCH_CONFIG, provider: 'duckduckgo' },
      }),
      plan: [
        { tool: 'web_search', params: { query: 'one', limit: 0 } },
        { tool: 'web_search', params: { query: 'two', limit: 0 } },
        { tool: 'web_search', params: { query: 'three', limit: 0 } },
        { tool: 'web_fetch', params: { url: PAGE_URL } },
        { tool: 'web_fetch', params: { url: SECOND_URL } },
        { tool: 'browser_navigate', params: { url: PAGE_URL } },
      ],
      holder,
    });

    // One pool process for five background pages; one task browser.
    expect(launchedBy).toEqual(['web_search', 'browser_navigate']);
    expect(contexts).toBe(5);
    const health = JSON.parse(
      await readFile(join(result.outcome.runDir, 'run-health.json'), 'utf8'),
    ) as { readonly browser: Record<string, number> };
    expect(health.browser).toEqual({ launches: 2, pool_launches: 1, contexts: 5 });
    // Finalizer order: task browser teardown, then the pool, both before
    // run-health.json exists.
    expect(closes).toEqual([
      { tool: 'browser_navigate', runHealthWritten: false },
      { tool: 'web_search', runHealthWritten: false },
    ]);
  }, 60_000);

  it('resolves the search provider once per run: 22 searches, one "selected search provider"', async () => {
    // The leaf logs exactly as the production resolver does on success; the
    // run's search service must call it once, however many searches run.
    const provider: SearchProvider = {
      name: 'tavily',
      search: () =>
        Promise.resolve([
          {
            url: PAGE_URL,
            title: 'Leaf',
            snippet: null,
            source: 'tavily',
            rank: 1,
            publishedAt: null,
          },
        ]),
    };
    const resolver = vi.fn(
      (options: {
        readonly deps: { readonly logger: { info: (o: object, m: string) => void } };
      }) => {
        options.deps.logger.info({ provider: 'tavily', via: 'auto' }, 'selected search provider');
        return Promise.resolve(ok(provider));
      },
    );

    const { outcome } = await run({
      leaves: hermeticLeaves({
        resolveSearchProvider: resolver as unknown as EnvironmentLeaves['resolveSearchProvider'],
      }),
      plan: Array.from({ length: 22 }, (_, i) => ({
        tool: 'web_search',
        params: { query: `query ${i}`, limit: 0 },
      })),
      profile: 'research',
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    const runtime = (await readFile(join(outcome.runDir, 'runtime.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(runtime.filter((line) => line.msg === 'selected search provider')).toHaveLength(1);
    const health = JSON.parse(await readFile(join(outcome.runDir, 'run-health.json'), 'utf8')) as {
      readonly searches: Record<string, unknown>;
    };
    expect(health.searches).toMatchObject({ total: 22, ok: 22, breaker_skipped: 0 });
  }, 60_000);

  it('audits a challenge at both tiers and discloses it in the Brief, never as a source', async () => {
    const CHALLENGE_HTML =
      '<html><head><title>One moment</title></head><body><form action="/v">' +
      '<h1>Please verify you are human</h1><div data-sitekey="k"></div></form></body></html>';
    const challengeBrowser: BrowserProvider = {
      launch: () => {
        const page = {
          goto: () => Promise.resolve({ status: () => 200 }),
          evaluate: () => Promise.resolve(CHALLENGE_HTML),
          url: () => PAGE_URL,
          close: () => Promise.resolve(),
          on: () => undefined,
        };
        return Promise.resolve({
          id: 'challenge-session',
          profilePath: '',
          newPage: () => Promise.resolve(page),
          newIsolatedPage: () => Promise.resolve(page),
          close: () => Promise.resolve(),
          on: () => undefined,
        } as unknown as BrowserSession);
      },
      detectChrome: () => Promise.resolve(null),
    };
    const httpRequestFn = vi.fn(() =>
      Promise.resolve(httpResponse(200, CHALLENGE_HTML)),
    ) as unknown as NonNullable<EnvironmentLeaves['httpRequestFn']>;

    const { outcome, driver } = await run({
      leaves: hermeticLeaves({ createBrowserProvider: () => challengeBrowser, httpRequestFn }),
      plan: [
        { tool: 'web_fetch', params: { url: PAGE_URL } },
        { tool: 'web_fetch', params: { url: PAGE_URL } },
      ],
      profile: 'research',
    });

    expect(driver.results.slice(0, 2).map((result) => result.status)).toEqual(['error', 'error']);
    expect(driver.results[0]?.modelText).toContain('SITE_CHALLENGE');
    // One HTTP request and one render, then the memo: never a third read.
    expect(httpRequestFn).toHaveBeenCalledTimes(1);
    const runtime = (await readFile(join(outcome.runDir, 'runtime.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const challenges = runtime.filter((line) => line.event === 'fetch_challenge');
    expect(challenges.map((line) => [line.level, line.tier, line.marker, line.host])).toEqual([
      [40, 'http', 'data-sitekey', 'leaf.example.test'],
      [40, 'browser', 'data-sitekey', 'leaf.example.test'],
    ]);
    const escalated = runtime.filter((line) => line.event === 'fetch_escalated');
    expect(escalated.map((line) => [line.level, line.reason, line.host])).toEqual([
      [30, 'http-challenge', 'leaf.example.test'],
    ]);
    for (const line of [...challenges, ...escalated]) {
      expect(JSON.stringify(line)).not.toContain('/article');
      assertRuntimeEventIsSafe(line, []);
    }
    const brief = JSON.parse(await readFile(join(outcome.runDir, 'brief.json'), 'utf8')) as {
      readonly sources: readonly unknown[];
      readonly notices: readonly { kind: string; source: string }[];
    };
    expect(brief.sources).toEqual([]);
    expect(brief.notices).toContainEqual(
      expect.objectContaining({ kind: 'blocked', source: 'leaf.example.test' }),
    );
    const health = JSON.parse(await readFile(join(outcome.runDir, 'run-health.json'), 'utf8')) as {
      readonly fetches: { readonly challenges: unknown; readonly memo_hits: number };
    };
    expect(health.fetches).toMatchObject({ challenges: { http: 1, browser: 1 }, memo_hits: 1 });
  });

  it('ignores environmentLeaves entirely when createEnvironment is supplied', async () => {
    const untouchable = (): never => {
      throw new Error('a leaf was used although createEnvironment was supplied');
    };
    const leaves: Partial<EnvironmentLeaves> = {
      createBrowserProvider: vi.fn(untouchable),
      resolveSearchProvider: vi.fn(untouchable),
      httpRequestFn: vi.fn(untouchable) as unknown as NonNullable<
        EnvironmentLeaves['httpRequestFn']
      >,
    };
    const environmentFor = (context: {
      readonly runId: string;
      readonly runDir: string;
    }): AgenticRunEnvironment => ({
      browserController: {
        teardown: () => Promise.resolve(),
      } as unknown as AgenticRunEnvironment['browserController'],
      domain: {
        search: {
          service: searchServiceFor({ name: 'duckduckgo', search: () => Promise.resolve([]) }),
          resultCap: 5,
          fetchTop: 1,
        },
        fetch: {
          fetcher: { fetch: () => Promise.reject(new Error('no fetches in this run')) },
          extractor: new ReadabilityExtractor(),
          ethics: { check: () => Promise.resolve() },
          allowedContentTypes: ['text/html'],
          maxContentBytes: 1024,
          captureThresholdBytes: 1024,
        },
        script: { registry: new ScriptRegistry() },
        publish: createBriefPublisher(context.runDir, {
          taskId: generateUlid(),
          runId: context.runId,
        }),
        browser: null,
        rank: null,
        workflow: null,
      },
    });

    const { outcome } = await run({
      leaves,
      createEnvironment: (context) => Promise.resolve(environmentFor(context)),
      plan: [{ tool: 'web_search', params: { query: 'anything' } }],
      profile: 'research',
    });

    expect(outcome.kind).toBe('published');
    expect(leaves.createBrowserProvider).not.toHaveBeenCalled();
    expect(leaves.resolveSearchProvider).not.toHaveBeenCalled();
    expect(leaves.httpRequestFn).not.toHaveBeenCalled();
  });
});
