/**
 * The integrated FEAT-048 contract, pinned against the G4/G6/G8 fault mix of
 * run `20260925T130634Z` (TASK-009).
 *
 * A scripted session drives the run's REAL wrapped tools through the real
 * middleware and catalog, and emits each result through the real Pi seam
 * sanitizer exactly as the production adapter does. A scripted search
 * provider throws the real typed core errors; fetchers are local. Every
 * assertion is made on the finished run directory's public artifacts only.
 */

import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DefaultSanitizer,
  ScrapeSearchError,
  ScriptRegistry,
  type AgentBrowserController,
  type ContentFetcher,
  type DomainRankSignal,
  type EthicsGate,
  type ExtractedArticle,
  type FetchedDoc,
  type PageExtractor,
  type SearchProvider,
  type SearchResult,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { RunHealth, UsageLedger, generateUlid, validateBrief } from '@yantra/protocol';
import {
  assertRuntimeLinesAreSafe,
  parseRuntimeLog,
  runtimeEventsNamed,
} from '@yantra/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultPiEventMapContext } from '../../src/adapters/pi/event-map.js';
import {
  buildYantraWrappedTools,
  createBriefPublisher,
  toAgentToolResult,
} from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/types.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import { runAgenticTask, type AgenticRunEnvironment } from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { RunRuntimeLog } from '../../src/runtime/runtime-log.js';
import { articlePageAnalysis, searchServiceFor } from '../adapters/pi/tools/test-support.js';

const CANARIES = {
  apiKey: 'sk-FAULTMIXcanaryABCDEFGHIJKLMN',
  email: 'owner.canary@dealer.example',
} as const;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  );
});

function hit(url: string, rank: number): SearchResult {
  return {
    url,
    title: `Listing ${rank}`,
    snippet: `snippet for ${url}`,
    source: 'duckduckgo',
    rank,
    publishedAt: null,
  };
}

/**
 * Provider call N (1-based): 2 returns nothing, 5 hits an anti-bot challenge,
 * and 1, 3, and 4 return hits. The navigation budget (5) is spent by the time
 * call 4's three hits are read, so two of them are skipped. The challenge opens
 * the run's search breaker (FEAT-050), so the script's 6th and 7th searches
 * are refused as `circuit-open` without reaching this provider at all.
 */
function scriptedSearchProvider(): SearchProvider & { readonly calls: () => number } {
  let call = 0;
  const results: Readonly<Record<number, readonly SearchResult[]>> = {
    1: [hit('https://alpha.example/listing/1', 1), hit('https://beta.example/listing/1', 2)],
    3: [hit('https://gamma.example/listing/1', 1), hit('https://delta.example/listing/1', 2)],
    4: [
      hit('https://epsilon.example/listing/1', 1),
      hit('https://zeta.example/listing/1', 2),
      hit('https://eta.example/listing/1', 3),
    ],
  };
  return {
    name: 'duckduckgo',
    calls: () => call,
    search: () => {
      call += 1;
      if (call === 5) {
        return Promise.reject(
          new ScrapeSearchError('DuckDuckGo served an anti-bot challenge.', {
            provider: 'duckduckgo',
            host: 'html.duckduckgo.com',
            code: 'anomaly-challenge',
          }),
        );
      }
      if (call === 2) {
        return Promise.reject(
          new ScrapeSearchError('DuckDuckGo search did not return result rows.', {
            provider: 'duckduckgo',
            host: 'html.duckduckgo.com',
            code: 'empty-results',
          }),
        );
      }
      return Promise.resolve(results[call] ?? []);
    },
  };
}

const localFetcher: ContentFetcher = {
  fetch: (url): Promise<FetchedDoc> =>
    Promise.resolve({
      url,
      finalUrl: url,
      fetchedAt: '2026-10-10T00:00:00.000Z',
      contentType: 'text/html',
      html: '<article>listing</article>',
      statusCode: 200,
      fetchMode: 'http',
      elapsedMs: 3,
    }),
};

/** Page text ends a URL right before a JSON-escaped quote and carries canaries. */
const localExtractor: PageExtractor = {
  extract: (doc) => Promise.resolve(localArticle(doc)),
  extractPage: (doc) => {
    const article = localArticle(doc);
    return Promise.resolve({ article, page: articlePageAnalysis(article.contentText) });
  },
};

function localArticle(doc: FetchedDoc): ExtractedArticle {
  return {
    url: doc.finalUrl,
    title: `Listing at ${new URL(doc.finalUrl).hostname}`,
    byline: null,
    publishedAt: null,
    siteName: null,
    contentText:
      `New 2026 listing near you, see ${doc.finalUrl}/dallas-tx/ for more. ` +
      `Contact ${CANARIES.email} (api ${CANARIES.apiKey}).`,
    contentHtml: '<p>listing</p>',
    excerpt: `Listing excerpt for ${new URL(doc.finalUrl).hostname}`,
    lengthChars: 120,
  };
}

interface Step {
  readonly tool: string;
  readonly params: Record<string, unknown>;
}

/** Four provider turns: three of searches, one publish. */
const TURNS: readonly (readonly Step[])[] = [
  [
    { tool: 'web_search', params: { query: '2026 santa fe calligraphy dallas' } },
    { tool: 'web_search', params: { query: '2026 santa fe calligraphy awd listings' } },
  ],
  [
    { tool: 'web_search', params: { query: 'santa fe calligraphy dealer frisco' } },
    { tool: 'web_search', params: { query: 'santa fe calligraphy inventory' } },
    { tool: 'web_search', params: { query: 'santa fe calligraphy vehicledetails' } },
  ],
  [
    { tool: 'web_search', params: { query: 'inurl:vehicledetails santa fe' } },
    { tool: 'web_search', params: { query: 'santa fe calligraphy awd price' } },
  ],
  [
    {
      tool: 'result_publish',
      params: {
        brief: { title: 'Santa Fe Calligraphy offers', overview: 'Partial answer from listings.' },
      },
    },
  ],
];

/**
 * A session that executes the run's real wrapped tools and projects every
 * call through the production seam: `toAgentToolResult` then the default Pi
 * event-map sanitizer.
 */
class ScriptedSessionProvider implements AgentProvider {
  public constructor(private readonly services: RunServices) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const seam = createDefaultPiEventMapContext();
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => {
      for (const listener of listeners) listener(event);
    };
    let calls = 0;
    const session: AgentSession = {
      id: 'fault-mix-session',
      logPath: join(options.runDir, 'agent', 'fault-mix-session.jsonl'),
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        for (const turn of TURNS) {
          for (const step of turn) {
            const tool = tools.get(step.tool);
            if (tool === undefined) throw new Error(`scenario asked for absent tool ${step.tool}`);
            const callId = `call-${(calls += 1)}`;
            emit({
              type: 'tool_started',
              callId,
              tool: step.tool,
              input: seam.sanitizePayload(step.params),
              at: seam.now(),
            });
            const result = await tool.execute(step.params, undefined);
            emit({
              type: 'tool_finished',
              callId,
              tool: step.tool,
              output: seam.sanitizePayload(toAgentToolResult(result)),
              isError: result.status !== 'ok',
              at: seam.now(),
            });
          }
          emit({
            type: 'turn_finished',
            usage: { turns: 1, inputTokens: 1000, outputTokens: 100, costUsd: 0.002 },
            at: seam.now(),
          });
        }
        return {
          outcome: 'completed',
          stopReason: 'stop',
          usage: { turns: TURNS.length, inputTokens: 4000, outputTokens: 400, costUsd: 0.008 },
        };
      },
    };
    return Promise.resolve(session);
  }
}

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;
  public requestConfirmation(): Promise<'granted'> {
    return Promise.resolve('granted');
  }
  public emitAgentEvent(_event: AgentProgressEvent): void {
    // Progress rendering is not what this scenario asserts.
  }
  public renderAgentOutcome(_outcome: AgenticTaskOutcome): void {
    // The outcome is returned directly.
  }
}

interface FinishedRun {
  readonly outcome: AgenticTaskOutcome;
  readonly runDir: string;
  readonly signals: readonly DomainRankSignal[];
  /** Searches that actually reached the scripted provider. */
  readonly providerCalls: number;
}

async function runScenario(): Promise<FinishedRun> {
  const root = await mkdtemp(join(tmpdir(), 'yantra-fault-mix-'));
  tempDirs.push(root);
  const signals: DomainRankSignal[] = [];
  const ethics: EthicsGate = { check: () => Promise.resolve() };
  // One instance for the run, behind the run's one search service, so the
  // script's call counter counts every search that reached the provider.
  const searchProvider = scriptedSearchProvider();

  const outcome = await runAgenticTask(
    {
      goal: 'Find top offers for a new 2026 Hyundai Santa Fe Calligraphy AWD',
      model: { provider: 'fixture', id: 'fixture-model' },
      auth: { mode: 'managed' },
      connector: new SilentConnector(),
      budgets: { maxNavigations: 5 },
    },
    {
      runStore: new LocalRunStore(root),
      sanitizer: new DefaultSanitizer(),
      createEnvironment: (context): Promise<AgenticRunEnvironment> => {
        const runtimeLog = RunRuntimeLog.open({ runId: context.runId, runDir: context.runDir });
        return Promise.resolve({
          browserController: {
            teardown: () => Promise.resolve(),
          } as unknown as Pick<AgentBrowserController, 'teardown'>,
          runtimeLogger: runtimeLog.logger,
          closeRuntimeLog: () => runtimeLog.close(),
          domain: {
            search: {
              service: searchServiceFor(searchProvider, { logger: runtimeLog.logger }),
              resultCap: 5,
              fetchTop: 3,
            },
            fetch: {
              fetcher: localFetcher,
              extractor: localExtractor,
              ethics,
              allowedContentTypes: ['text/html'],
              maxContentBytes: 1024 * 1024,
              captureThresholdBytes: 16 * 1024,
            },
            script: { registry: new ScriptRegistry() },
            publish: createBriefPublisher(context.runDir, {
              taskId: generateUlid(),
              runId: context.runId,
            }),
            browser: null,
            rank: { record: (signal) => signals.push(signal) },
            workflow: null,
          },
        });
      },
      createProvider: (services) => new ScriptedSessionProvider(services),
    },
  );
  return { outcome, runDir: outcome.runDir, signals, providerCalls: searchProvider.calls() };
}

async function readText(runDir: string, name: string): Promise<string> {
  return readFile(join(runDir, name), 'utf8');
}

async function readJsonl(runDir: string, name: string): Promise<Record<string, unknown>[]> {
  return (await readText(runDir, name))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every file under the run directory, recursively, as text. */
async function everyArtifact(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await everyArtifact(path)));
    else out.push({ path, text: await readFile(path, 'utf8') });
  }
  return out;
}

describe('@no-llm FEAT-048 integrated contract — the G4/G6/G8 fault mix', () => {
  it('produces a run whose every artifact tells the truth about it', async () => {
    const { outcome, runDir, signals, providerCalls } = await runScenario();

    expect(outcome.kind).toBe('published');

    // G8: every audit record re-parses, including double-encoded content text.
    const toolCalls = await readJsonl(runDir, 'tool-calls.jsonl');
    expect(toolCalls).toHaveLength(16);
    for (const line of toolCalls.filter((entry) => entry.phase === 'end')) {
      const output = line.output_sanitized as { content?: { type: string; text: string }[] };
      expect(typeof output).toBe('object');
      for (const part of output.content ?? []) {
        if (part.type === 'text') expect(() => JSON.parse(part.text) as unknown).not.toThrow();
      }
    }

    // G4: one tool_failure warn per failed call with the typed cause; one run_health.
    const runtime = parseRuntimeLog(await readText(runDir, 'runtime.jsonl'));
    const failures = runtimeEventsNamed(runtime, 'tool_failure');
    expect(failures.map((line) => `${line.code}:${line.cause}`)).toEqual([
      'SEARCH_NO_RESULTS:empty-results',
      'SEARCH_BLOCKED:anomaly-challenge',
      'SEARCH_BLOCKED:circuit-open',
      'SEARCH_BLOCKED:circuit-open',
    ]);
    // FEAT-050: the challenge opened the breaker; the last two searches were
    // never sent, and the breaker's opening is logged once.
    expect(providerCalls).toBe(5);
    expect(runtimeEventsNamed(runtime, 'search_breaker_open')).toHaveLength(1);
    for (const line of failures) {
      expect(line).toMatchObject({ level: 40, tool: 'web_search', provider: 'duckduckgo' });
    }
    expect(runtimeEventsNamed(runtime, 'run_health')).toHaveLength(1);
    assertRuntimeLinesAreSafe(runtime, Object.values(CANARIES));

    // G7: runtime-derived notices and the provider on the published Brief.
    const brief = validateBrief(JSON.parse(await readText(runDir, 'brief.json')));
    expect(brief.isOk).toBe(true);
    if (!brief.isOk) return;
    expect(brief.value.metadata.search_provider).toBe('duckduckgo');
    expect(brief.value.notices).toEqual([
      {
        kind: 'search_failed',
        source: 'search:duckduckgo',
        reason: '1 of 7 web searches failed: the provider returned no results (SEARCH_NO_RESULTS).',
      },
      {
        kind: 'search_failed',
        source: 'search:duckduckgo',
        reason:
          '3 of 7 web searches failed: the provider served an anti-bot challenge; 2 later ' +
          "searches were not attempted after the provider's challenge (SEARCH_BLOCKED).",
      },
      {
        kind: 'budget_exhausted',
        source: 'runtime',
        reason:
          "Yantra's navigation budget (5) was exhausted; 2 further page reads were not attempted.",
      },
    ]);

    // G6: no host refused by our own budget is penalized as having blocked us.
    for (const host of ['zeta.example', 'eta.example']) {
      expect(signals.filter((signal) => signal.domain === host)).toEqual([
        { domain: host, delta: 1, reason: 'search_result' },
      ]);
    }
    expect(signals.some((signal) => signal.reason === 'blocked')).toBe(false);

    // Run health: the file validates and its counts match the script.
    const health = RunHealth.parse(JSON.parse(await readText(runDir, 'run-health.json')));
    expect(health).toMatchObject({
      run_id: outcome.runId,
      searches: {
        total: 7,
        ok: 3,
        failed_by_code: { SEARCH_BLOCKED: 3, SEARCH_NO_RESULTS: 1 },
        providers: ['duckduckgo'],
        breaker_skipped: 2,
        peak_concurrency: 1,
      },
      fetches: { total: 5, by_mode: { http: 5, browser: 0 }, repeat_fetches: 0 },
      source_failures: { fetch: 0, extract: 0, blocked: 0, budget: 2, policy: 0 },
      budgets: { navigations_used: 5, navigations_limit: 5, exhausted: ['navigations'] },
      tool_failures: { total: 4 },
      notices: 3,
    });
    expect(await readText(runDir, 'report.md')).toContain('## Run Health');

    // G11: one usage call per scripted provider turn.
    const usage = UsageLedger.parse(JSON.parse(await readText(runDir, 'usage.json')));
    expect(usage.calls).toHaveLength(TURNS.length);
    expect(usage.totals.input_tokens).toBe(usage.agent?.input_tokens);

    // No canary survives anywhere in the run directory.
    const leaks = (await everyArtifact(runDir)).flatMap((artifact) =>
      Object.values(CANARIES)
        .filter((canary) => artifact.text.includes(canary))
        .map((canary) => `${artifact.path} leaked ${canary}`),
    );
    expect(leaks).toEqual([]);

    // The manifest and event stream still parse as before.
    expect(JSON.parse(await readText(runDir, 'manifest.json'))).toMatchObject({
      runId: outcome.runId,
    });
    const events = await readJsonl(runDir, 'events.jsonl');
    expect(events.map((event) => event.kind)).toEqual(['task_started', 'task_completed']);
  });
});
