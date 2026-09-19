/**
 * What a completed agentic run can be asked, from its artifacts alone.
 *
 * This is the integrated contract for FEAT-047, exercised end to end through a
 * real `LocalBrowserProvider`, a real compatibility service over a real on-disk
 * evidence cache, the real tool middleware, and the real run recorder. Only the
 * two genuine process boundaries are replaced: spawning Chrome and speaking
 * HTTP. Everything the run then writes is inspected through public artifacts —
 * `runtime.jsonl`, `tool-calls.jsonl`, `manifest.json`, `events.jsonl` and
 * `report.md` — never through a service handle the test happens to be holding.
 *
 * Two runs are compared, because that is where the original gap was: one whose
 * compatibility evidence is already cached (the ordinary case, and the one that
 * previously left no trace at all), and one that probes fresh.
 */

import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BrowserFallbackFetcher,
  BrowserResolutionError,
  CompatibilityCache,
  DefaultSanitizer,
  FetchError,
  HybridContentFetcher,
  LocalBrowserCompatibilityService,
  LocalBrowserProvider,
  ReadabilityExtractor,
  ScriptRegistry,
  DRIVER_COMPATIBILITY,
  type AgentBrowserController,
  type BrowserRuntimeServices,
  type CapabilityId,
  type ContentFetcher,
  type EthicsGate,
  type ExecutableIdentity,
  type Logger,
  type ManagedReadyRecord,
  type ResolvedBrowserInstallation,
  type SearchProvider,
} from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { generateUlid, type ConfirmationRequest } from '@yantra/protocol';
import {
  assertRuntimeLinesAreSafe,
  parseRuntimeLog,
  runtimeEventsNamed,
} from '@yantra/test-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createBriefPublisher,
  buildYantraWrappedTools,
} from '../../src/adapters/pi/tools/index.js';
import type {
  AgentEvent,
  AgentProvider,
  AgentRunResult,
  AgentSession,
} from '../../src/provider/index.js';
import type { AgentProgressEvent, AgentTaskConnector } from '../../src/runtime/connector.js';
import { runAgenticTask, type AgenticRunEnvironment } from '../../src/runtime/orchestrator.js';
import type { AgenticTaskOutcome } from '../../src/runtime/outcome.js';
import type { RunServices } from '../../src/runtime/run-services.js';
import { RunRuntimeLog } from '../../src/runtime/runtime-log.js';

/**
 * Planted in every field the run could leak from: a launch argument, helper
 * stderr, a raw error detail, the profile path, the executable path, the task
 * URL, and the page body itself.
 */
const CANARIES = Object.freeze({
  arg: '--canary=CANARY-ARGV-70b3',
  stderr: 'CANARY-STDERR-70b3',
  detail: 'CANARY-DETAIL-70b3',
  profilePath: '/home/canary/.yantra/profiles/CANARY-PROFILE-70b3',
  executablePath: '/home/canary/CANARY-EXEC-70b3/chrome',
  taskPath: 'CANARY-URL-70b3',
  pageText: 'CANARY-PAGE-BODY-70b3',
  secret: 'sk-CANARYSECRET70b3abcdefghijk',
});

const TASK_URL = `https://fixture.example.com/${CANARIES.taskPath}`;
const BROWSER_VERSION = '153.0.8010.36';

const READY_RECORD: ManagedReadyRecord = {
  schemaVersion: 1,
  installationId: 'fixture01',
  browser: 'chrome',
  platform: 'linux',
  buildId: BROWSER_VERSION,
  cacheRootRelative: 'installation-fixture01',
  executableRelative: 'chrome/linux/chrome',
  verifiedAt: '2026-09-12T00:00:00.000Z',
};

function installation(): ResolvedBrowserInstallation {
  return {
    canonicalPath: CANARIES.executablePath,
    version: BROWSER_VERSION,
    majorVersion: 153,
    platform: 'linux',
    architecture: 'x64',
    statFingerprint: `1:2:3:${BROWSER_VERSION}`,
    ownership: 'external',
    requestedSelection: { source: 'auto', executablePath: null },
    selectionOrigin: 'default',
    selectionReason: 'system-discovery',
    channel: 'stable',
    managedIdentity: null,
  };
}

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
    // Progress rendering is not what these artifacts assert.
  }

  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    this.outcomes.push(outcome);
  }
}

/**
 * A provider that actually drives the run's own wrapped tools.
 *
 * The tool lifecycle events it emits are what the run recorder projects into
 * `tool-calls.jsonl`, so the artifact this test reads is produced the same way
 * a real session produces it.
 */
class ToolDrivingProvider implements AgentProvider {
  public readonly results: Record<string, unknown>[] = [];

  public constructor(
    private readonly services: RunServices,
    /** Executed on the first prompt only; later prompts publish. */
    private readonly plan: readonly { tool: string; params: Record<string, unknown> }[],
  ) {}

  public open(options: { readonly runDir: string }): Promise<AgentSession> {
    const tools = new Map(buildYantraWrappedTools(this.services).map((tool) => [tool.name, tool]));
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => {
      for (const listener of listeners) listener(event);
    };
    const plan = this.plan;
    const results = this.results;
    let calls = 0;
    let runs = 0;
    const session: AgentSession = {
      id: 'fixture-session',
      // Absolute and inside the run directory: the recorder refuses a session
      // file it cannot prove the run owns.
      logPath: `${options.runDir}/agent/fixture-session.jsonl`,
      authSource: 'managed',
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      abort: () => Promise.resolve(),
      close: () => Promise.resolve(),
      run: async (): Promise<AgentRunResult> => {
        // The orchestrator prompts twice (the completion nudge), and a browser
        // launch per prompt would be two of everything. A real session does the
        // work once and then publishes, so this one does too.
        const steps =
          runs++ === 0
            ? plan
            : [
                {
                  tool: 'result_publish',
                  params: {
                    brief: {
                      title: 'Fixture result',
                      overview: 'The fixture completed its single browser-backed fetch. [1]',
                    },
                  },
                },
              ];
        for (const step of steps) {
          const tool = tools.get(step.tool);
          if (tool === undefined) throw new Error(`fixture asked for absent tool ${step.tool}`);
          const callId = `call-${(calls += 1)}`;
          const at = new Date().toISOString();
          emit({ type: 'tool_started', callId, tool: step.tool, input: step.params, at });
          const result = await tool.execute(step.params, undefined);
          results.push({ tool: step.tool, ...result });
          emit({
            type: 'tool_finished',
            callId,
            tool: step.tool,
            output: {
              status: result.status,
              ...(result.error_code ? { error_code: result.error_code } : {}),
            },
            isError: result.status !== 'ok',
            at: new Date().toISOString(),
          });
        }
        return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
      },
    };
    return Promise.resolve(session);
  }
}

interface BrowserFixture {
  readonly services: BrowserRuntimeServices;
  readonly probeLaunches: () => number;
  readonly taskLaunches: () => number;
  /** Stand-ins for the provider's two process/filesystem boundaries. */
  readonly identify: (path: string) => Promise<ExecutableIdentity | null>;
  readonly spawn: (...args: readonly unknown[]) => Promise<unknown>;
}

/**
 * Real selection + compatibility over a real cache, with Chrome replaced.
 *
 * `launchError` makes the *task* launch fail while the compatibility probe
 * still succeeds — the shape of a machine whose browser passes its checks and
 * then refuses to start for the run.
 */
function browserFixture(options: {
  readonly cacheRoot: string;
  readonly resolutionError?: Error;
  readonly launchError?: Error;
  readonly failingCapability?: CapabilityId;
  readonly pageFault?: Error;
}): BrowserFixture {
  let probeLaunches = 0;
  let taskLaunches = 0;
  const fakeBrowser = () => ({
    version: () => Promise.resolve(`HeadlessChrome/${BROWSER_VERSION}`),
    on: vi.fn(),
    pages: () => Promise.resolve([]),
    newPage: () =>
      Promise.resolve({
        goto: () =>
          options.pageFault
            ? Promise.reject(options.pageFault)
            : Promise.resolve({ status: () => 200 }),
        evaluate: () => Promise.resolve(`<html><body><p>${CANARIES.pageText}</p></body></html>`),
        url: () => TASK_URL,
        close: () => Promise.resolve(),
      }),
    close: () => Promise.resolve(),
  });
  const owned = (ownership: unknown) => {
    // A real EventEmitter: the session wires crash/exit handlers onto the child
    // during construction, and a plain object silently turns every launch into
    // a TypeError that looks exactly like a page failure.
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stderr: null;
    };
    child.pid = 4321;
    child.exitCode = null;
    child.signalCode = null;
    child.stderr = null;
    return {
      browser: fakeBrowser() as never,
      child: child as never,
      supervisor: { hasExited: () => false, whenExited: () => Promise.resolve() } as never,
      ownership: ownership as never,
      shutdown: () => Promise.resolve(),
    };
  };

  const compatibility = new LocalBrowserCompatibilityService({
    cache: new CompatibilityCache({ root: () => options.cacheRoot }),
    profileStore: {
      resolve: (spec) =>
        Promise.resolve({
          absolutePath: `${CANARIES.profilePath}-probe`,
          kind: spec.kind,
          createdNow: true,
        }),
      listWorkflowProfiles: () => Promise.resolve([]),
      removeWorkflowProfile: () => Promise.resolve(),
      cleanupEphemeral: () => Promise.resolve(),
    },
    capabilityRunners: Object.fromEntries(
      DRIVER_COMPATIBILITY.capabilities.map((row) => [
        row.id,
        row.id === options.failingCapability
          ? () => Promise.reject(new Error(CANARIES.detail))
          : () => Promise.resolve(),
      ]),
    ) as never,
    launch: (_o, _i, _p, ownership) => {
      probeLaunches += 1;
      return Promise.resolve(owned(ownership) as never);
    },
  });

  return {
    probeLaunches: () => probeLaunches,
    taskLaunches: () => taskLaunches,
    // The binary the resolver named is fictional, so identity is answered from
    // the fixture instead of the filesystem. Returning the SAME fingerprint the
    // resolver reported is what makes this an ordinary launch rather than a
    // revalidation-triggered re-resolve.
    identify: (path: string) =>
      Promise.resolve({
        canonicalPath: path,
        version: BROWSER_VERSION,
        majorVersion: 153,
        platform: 'linux' as NodeJS.Platform,
        architecture: 'x64',
        statFingerprint: `1:2:3:${BROWSER_VERSION}`,
      }),
    spawn: (...args: readonly unknown[]) => {
      taskLaunches += 1;
      if (options.launchError) return Promise.reject(options.launchError);
      return Promise.resolve(owned(args[3]));
    },
    services: {
      resolver: {
        resolve: () =>
          Promise.resolve(
            options.resolutionError
              ? { status: 'unavailable', error: options.resolutionError as BrowserResolutionError }
              : { status: 'resolved', installation: installation() },
          ),
      },
      compatibility,
      coordinator: {
        reserveUse: vi.fn(),
        claimMutation: vi.fn(),
        hasActiveUse: () => Promise.resolve(false),
      },
      managedState: {
        readReady: () => Promise.resolve({ status: 'ready', record: READY_RECORD }),
        readInventory: () =>
          Promise.resolve({ ready: { status: 'ready', record: READY_RECORD }, orphans: [] }),
      },
    },
  } as BrowserFixture;
}

interface RunResult {
  readonly outcome: AgenticTaskOutcome;
  readonly runDir: string;
  readonly runtime: Record<string, unknown>[];
  readonly toolCalls: Record<string, unknown>[];
  readonly report: string;
  readonly manifest: Record<string, unknown>;
  readonly events: Record<string, unknown>[];
  readonly probeLaunches: number;
  readonly toolResults: readonly Record<string, unknown>[];
  /** The run's own services, for the model-input boundary assertion. */
  readonly services: RunServices | undefined;
}

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })),
  );
});

describe('@no-llm agentic run browser observability contract', () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), 'yantra-obs-cache-'));
    tempDirs.push(cacheRoot);
    LocalBrowserProvider.resetInstallOfferForTests();
  });

  /**
   * Runs one complete task whose only tool call is a `web_fetch` that the HTTP
   * transport refuses, forcing the hybrid fetcher into its browser fallback.
   */
  async function runOnce(
    options: {
      readonly resolutionError?: Error;
      readonly failingCapability?: CapabilityId;
      readonly pageFault?: Error;
    } = {},
  ): Promise<RunResult> {
    const root = await mkdtemp(join(tmpdir(), 'yantra-obs-run-'));
    tempDirs.push(root);
    const fixture = browserFixture({ cacheRoot, ...options });
    let captured: RunServices | undefined;
    let driver: ToolDrivingProvider | undefined;

    const environmentFor = (context: {
      readonly runId: string;
      readonly runDir: string;
    }): AgenticRunEnvironment => {
      const runtimeLog = RunRuntimeLog.open({ runId: context.runId, runDir: context.runDir });
      const logger: Logger = runtimeLog.logger;
      const provider = new LocalBrowserProvider({
        profileStore: {
          resolve: (spec) =>
            Promise.resolve({
              absolutePath: CANARIES.profilePath,
              kind: spec.kind,
              createdNow: true,
            }),
          listWorkflowProfiles: () => Promise.resolve([]),
          removeWorkflowProfile: () => Promise.resolve(),
          cleanupEphemeral: () => Promise.resolve(),
        },
        services: fixture.services,
        logger,
        identify: fixture.identify as never,
        launch: fixture.spawn as never,
      });
      const ethics: EthicsGate = { check: () => Promise.resolve() };
      const search: SearchProvider = { name: 'duckduckgo', search: () => Promise.resolve([]) };
      // HTTP refuses the bot UA, which is exactly the condition the hybrid
      // fetcher escalates to a browser for.
      const httpFetcher: ContentFetcher = {
        fetch: (url) =>
          Promise.reject(
            new FetchError('HTTP 403 for the bot user agent.', {
              url,
              kind: 'http-status',
              statusCode: 403,
            }),
          ),
      };
      return {
        browserController: {
          teardown: () => Promise.resolve(),
        } as unknown as Pick<AgentBrowserController, 'teardown'>,
        runtimeLogger: logger,
        closeRuntimeLog: () => runtimeLog.close(),
        domain: {
          search: {
            resolveProvider: () => Promise.resolve({ isOk: true, value: search }),
            resultCap: 5,
            fetchTop: 3,
          },
          fetch: {
            fetcher: new HybridContentFetcher({
              httpFetcher,
              browserFetcher: new BrowserFallbackFetcher({ browserProvider: provider }),
            }),
            extractor: new ReadabilityExtractor(),
            ethics,
            allowedContentTypes: ['text/html', 'text/plain'],
            maxContentBytes: 5 * 1024 * 1024,
            captureThresholdBytes: 16 * 1024,
          },
          script: { registry: new ScriptRegistry() },
          publish: createBriefPublisher(context.runDir, {
            // A real ULID: the Brief schema rejects anything else, and a
            // rejected publication would leave this fixture asserting an
            // unpublished run without saying so.
            taskId: generateUlid(),
            runId: context.runId,
          }),
          browser: null,
          rank: null,
          workflow: null,
        },
      };
    };

    const outcome = await runAgenticTask(
      {
        goal: `Read ${TASK_URL} and report it`,
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        connector: new SilentConnector(),
        allowedHosts: ['fixture.example.com'],
      },
      {
        runStore: new LocalRunStore(root),
        sanitizer: new DefaultSanitizer(),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: true },
        createEnvironment: (context) => Promise.resolve(environmentFor(context)),
        createProvider: (services) => {
          captured = services;
          driver = new ToolDrivingProvider(services, [
            { tool: 'web_fetch', params: { url: TASK_URL } },
          ]);
          return driver;
        },
      },
    );

    const runDir = outcome.runDir;
    return {
      outcome,
      runDir,
      services: captured,
      runtime: parseRuntimeLog(await readFile(join(runDir, 'runtime.jsonl'), 'utf8')),
      toolCalls: await readJsonl(join(runDir, 'tool-calls.jsonl')),
      report: await readFile(join(runDir, 'report.md'), 'utf8'),
      manifest: JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >,
      events: await readJsonl(join(runDir, 'events.jsonl')),
      probeLaunches: fixture.probeLaunches(),
      toolResults: driver?.results ?? [],
    };
  }

  it('records one complete browser_ready for a cached-evidence run and lists it in the report', async () => {
    // Seed the shared cache the way an earlier run on this machine would have.
    await runOnce();
    const cached = await runOnce();

    const ready = runtimeEventsNamed(cached.runtime, 'browser_ready');
    expect(ready).toHaveLength(1);
    expect(cached.probeLaunches).toBe(0);
    expect(ready[0]).toMatchObject({
      schema_version: 1,
      selection_source: 'auto',
      selection_reason: 'system-discovery',
      ownership: 'external',
      browser_version: BROWSER_VERSION,
      executable_basename: 'chrome',
      probe_profile: 'automation',
      compatibility_verdict: 'passed',
      pairing: 'capability-checked',
      evidence_source: 'cache',
    });
    expect(cached.report).toContain('- runtime.jsonl');
    // The launch this event describes really happened: the browser fallback
    // rendered the page and the run published on the strength of it.
    expect(cached.outcome.kind).toBe('published');
    const fetched = cached.toolCalls.filter(
      (entry) => entry.phase === 'end' && entry.tool === 'web_fetch',
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ status: 'ok' });
    // No update or availability metadata call belongs on an ordinary run.
    expect(JSON.stringify(cached.runtime)).not.toMatch(/update|availability|download/iu);
  });

  it('describes a fresh run with the same required fields as a cached one', async () => {
    const fresh = await runOnce();
    const cached = await runOnce();

    const freshReady = runtimeEventsNamed(fresh.runtime, 'browser_ready')[0]!;
    const cachedReady = runtimeEventsNamed(cached.runtime, 'browser_ready')[0]!;

    expect(fresh.probeLaunches).toBe(1);
    expect(cached.probeLaunches).toBe(0);
    expect(freshReady.evidence_source).toBe('probe');
    expect(cachedReady.evidence_source).toBe('cache');
    // Pino stamps run_id/level/time per line, so compare the projection keys.
    const projection = (line: Record<string, unknown>): string[] =>
      Object.keys(line)
        .filter((key) => !['level', 'time', 'pid', 'hostname', 'msg', 'run_id'].includes(key))
        .sort();
    expect(projection(cachedReady)).toEqual(projection(freshReady));
    const shared = projection(freshReady).filter(
      (key) => key !== 'evidence_source' && key !== 'evidence_checked_at',
    );
    const pick = (line: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(shared.map((key) => [key, line[key]]));
    expect(pick(cachedReady)).toEqual(pick(freshReady));
    // And each run's log is its own: neither carries the other's run id.
    expect(new Set(fresh.runtime.map((line) => line.run_id)).size).toBe(1);
    expect(fresh.runtime[0]!.run_id).not.toBe(cached.runtime[0]!.run_id);
  });

  it('surfaces a typed resolution failure under its stable code in tool-calls.jsonl', async () => {
    const run = await runOnce({
      resolutionError: new BrowserResolutionError({
        code: 'missing',
        message: `No browser was found near ${CANARIES.executablePath}.`,
        requestedSelection: { source: 'auto', executablePath: null },
        remediation: 'Run `yantra browser install`.',
      }),
    });

    const ends = run.toolCalls.filter(
      (entry) => entry.phase === 'end' && entry.tool === 'web_fetch',
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ tool: 'web_fetch', error_code: 'BROWSER_RESOLUTION_FAILED' });
    expect(JSON.stringify(run.toolCalls)).not.toContain('TOOL_EXECUTION_FAILED');
    // And the operator log says which phase refused, by class alone.
    const failed = runtimeEventsNamed(run.runtime, 'browser_startup_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      phase: 'resolution',
      error_class: 'BrowserResolutionError',
      failure_kind: 'resolution',
      resolution_code: 'missing',
    });
    expect(runtimeEventsNamed(run.runtime, 'browser_ready')).toEqual([]);
  });

  it('surfaces a typed compatibility failure under its stable code', async () => {
    const run = await runOnce({ failingCapability: 'click-replace' });

    const ends = run.toolCalls.filter(
      (entry) => entry.phase === 'end' && entry.tool === 'web_fetch',
    );
    expect(ends[0]).toMatchObject({
      tool: 'web_fetch',
      error_code: 'BROWSER_COMPATIBILITY_FAILED',
    });
    const failed = runtimeEventsNamed(run.runtime, 'browser_startup_failed');
    expect(failed[0]).toMatchObject({
      phase: 'compatibility',
      failure_kind: 'compatibility',
      compatibility_failure_class: 'capability-failure',
    });
  });

  it('keeps a site fault generic to the model but distinguishable to the operator', async () => {
    const siteFault = new Error(`Navigation to ${TASK_URL} failed: ${CANARIES.detail}`);

    const run = await runOnce({ pageFault: siteFault });

    const ends = run.toolCalls.filter(
      (entry) => entry.phase === 'end' && entry.tool === 'web_fetch',
    );
    expect(ends[0]).toMatchObject({ tool: 'web_fetch', error_code: 'TOOL_EXECUTION_FAILED' });
    // Generic to the model, but the operator can still tell it apart from a
    // startup refusal — by class, tool and phase, and nothing else.
    const unexpected = runtimeEventsNamed(run.runtime, 'tool_unexpected_failure');
    expect(unexpected).toHaveLength(1);
    expect(unexpected[0]).toMatchObject({
      schema_version: 1,
      tool: 'web_fetch',
      operation_phase: 'domain',
      error_class: 'Error',
    });
    expect(runtimeEventsNamed(run.runtime, 'browser_startup_failed')).toEqual([]);
  });

  it('leaks no canary, URL, page text, path, argument, or raw detail into runtime.jsonl', async () => {
    const runs = [
      await runOnce(),
      await runOnce({ failingCapability: 'frame-token' }),
      await runOnce({ pageFault: new Error(`boom ${CANARIES.detail} ${CANARIES.secret}`) }),
      await runOnce({
        resolutionError: new BrowserResolutionError({
          code: 'invalid-executable',
          message: `Broken binary at ${CANARIES.executablePath}`,
          requestedSelection: { source: 'auto', executablePath: null },
          remediation: `Reinstall; ${CANARIES.detail}`,
        }),
      }),
    ];

    for (const run of runs) {
      expect(run.runtime.length).toBeGreaterThan(0);
      assertRuntimeLinesAreSafe(run.runtime, [...Object.values(CANARIES), TASK_URL]);
    }
  });

  it('keeps the manifest, events, and report parseable with no schema migration', async () => {
    const run = await runOnce();

    expect(run.manifest).toHaveProperty('agent');
    expect(run.events.some((entry) => entry.kind === 'task_started')).toBe(true);
    expect(run.report).toContain('## Audit Trail');
    expect(run.report).toContain('- tool-calls.jsonl');
    expect(run.report).toContain('- events.jsonl');
    // The report never parses the runtime log; it only names it.
    expect(run.report).not.toContain('browser_ready');
    // And the log is not model input: it is not an evidence source, and no
    // published artifact references it.
    const files = await readdir(run.runDir);
    expect(files).toContain('runtime.jsonl');
    // No destination outlives the run. On Windows an open handle blocks a
    // rename outright, so this is a real leak check rather than a formality;
    // elsewhere it is a cheap no-op that still proves the file is complete.
    const moved = join(run.runDir, 'runtime.jsonl.closed');
    await rename(join(run.runDir, 'runtime.jsonl'), moved);
    await rename(moved, join(run.runDir, 'runtime.jsonl'));
    // Not model input: the log is not in the evidence ledger the Brief is
    // built from, and the ledger is the only path page data takes to the model.
    const ledger = run.services?.evidence.entries() ?? [];
    expect(ledger.length).toBeGreaterThan(0);
    expect(ledger.some((entry) => entry.url.includes('runtime.jsonl'))).toBe(false);
    expect(run.toolResults.some((r) => JSON.stringify(r).includes('runtime.jsonl'))).toBe(false);
    for (const name of files.filter((file) => file.startsWith('brief.'))) {
      expect(await readFile(join(run.runDir, name), 'utf8')).not.toContain('runtime.jsonl');
    }
  });

  it('keeps browser startup mapping in exactly one module', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { dirname, join: joinPath, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(srcRoot);

    // A second table would drift: one boundary would learn a new class and the
    // other would keep flattening it to TOOL_EXECUTION_FAILED.
    const definers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('export function mapBrowserStartupError'),
    );
    expect(definers).toHaveLength(1);
    expect(definers[0]!.replaceAll('\\', '/')).toContain('browser-startup-errors.ts');

    const codes = ['BROWSER_RESOLUTION_FAILED', 'BROWSER_COMPATIBILITY_FAILED'];
    for (const code of codes) {
      const emitters = files.filter(
        (file) =>
          readFileSync(file, 'utf8').includes(`'${code}'`) &&
          !file.replaceAll('\\', '/').endsWith('browser-startup-errors.ts') &&
          !file.replaceAll('\\', '/').endsWith('runtime/messages.ts'),
      );
      expect({ code, emitters }).toEqual({ code, emitters: [] });
    }
  });
});

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
