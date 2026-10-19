/**
 * `runScenario`: one task-fidelity scenario through the production agentic
 * pipeline (FEAT-049 TASK-005).
 *
 * The run goes through `runAgenticTask` and the production environment
 * composer. Only leaves are replaced (`environmentLeaves`): the HTTP transport
 * and browser factory are host-mapped onto the loopback fixture server, the
 * search resolver returns the scripted provider, and the keychain is in-memory
 * in the deterministic tier. Everything a measure reads is captured after the
 * run has fully finalized: the outcome, every artifact (tolerantly — an absent
 * file reads as `null`, never a throw), the scripted agent's received results,
 * and the harness's own independent counts (fixture requests, search calls,
 * browser launches, rank signals, refused egress).
 */

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Writable } from 'node:stream';

import {
  resolveCommandTaskProfile,
  runAgenticTask,
  type AgentAuthSelection,
  type AgentBudgetConfig,
  type AgentModelSelection,
  type AgentProgressEvent,
  type AgentTaskConnector,
  type AgenticTaskOutcome,
  type EnvironmentLeaves,
} from '@yantra/agent';
import { CLIConnectorIO, TerminalRenderer, exitCodeForDoOutcome } from '@yantra/cli';
import {
  BlocklistImpl,
  DEFAULT_SEARCH_CONFIG,
  brandSanitized,
  createSelectedBrowserProvider,
  DefaultSanitizer,
  FileWorkflowStore,
  LocalBrowserProvider,
  LocalProfileStore,
  workflowsRoot,
  defaultEthicsConfig,
  resetPathCache,
  sanitize,
  type DomainRankSignal,
  type KeychainProvider,
  type RankSignalSink,
  type Sanitized,
} from '@yantra/core';
import { LocalRunStore, RunOrchestrator } from '@yantra/core/workflow/replay';
import type { ConfirmationRequest } from '@yantra/protocol';

import {
  ScriptedAgentProvider,
  type ReceivedResult,
  type ScriptReport,
} from './agent/scripted-provider.js';
import { latestFormStates, type FormState } from './fixtures/form-state.js';
import {
  EgressLog,
  HarnessSetupError,
  LaunchCounter,
  hostMappedBrowserProvider,
  mappedRequestFn,
} from './fixtures/host-mapping.js';
import { serveTaskSites, type RequestLogEntry } from './fixtures/server.js';
import type { Scenario } from './scenario.js';
import {
  ScriptedSearchProvider,
  scriptedSearchLeaf,
  type SearchCallRecord,
} from './search/scripted-provider.js';

/** A JSONL artifact: parsed lines plus the 1-based numbers of lines that did not parse. */
export interface JsonlArtifact {
  readonly lines: readonly unknown[];
  readonly unparseable: readonly number[];
}

/** Every run artifact a measure may read. An absent file is `null`. */
export interface RunArtifacts {
  readonly manifest: unknown;
  readonly brief: unknown;
  readonly document: unknown;
  readonly toolCalls: JsonlArtifact | null;
  readonly events: JsonlArtifact | null;
  readonly runtime: JsonlArtifact | null;
  readonly usage: unknown;
  readonly report: string | null;
  readonly runHealth: unknown;
  /** `contract.json`, when the run declared a task contract (FEAT-052). */
  readonly contract: unknown;
  /** JSON artifacts that exist but do not parse, by file name. */
  readonly unparseableJson: readonly string[];
  /** Referenced run-local captures; absent on older/synthetic runs. Never model input. */
  readonly captures?: Readonly<Record<string, unknown>>;
}

/** Everything a measure may read about one completed scenario run. */
export interface ScenarioRun {
  readonly replay?: {
    readonly outcome: string;
    readonly formState: Readonly<Record<string, FormState>>;
    readonly workflow: unknown;
  };
  readonly formState: Readonly<Record<string, FormState>>;
  readonly formInitialState?: Readonly<Record<string, FormState>>;
  readonly surfaces: {
    readonly firstLine: string;
    readonly json: unknown;
    readonly exitCode: number;
  } | null;
  readonly scenario: Scenario;
  readonly mode: RunMode;
  readonly outcome: AgenticTaskOutcome;
  readonly runDir: string;
  readonly artifacts: RunArtifacts;
  /** Deterministic tier only: what the scripted agent received. Empty in agentic mode. */
  readonly toolResults: readonly ReceivedResult[];
  readonly unreachable: readonly string[];
  readonly skipped: readonly string[];
  /** Deterministic tier only: the tool catalog the run's profile registered. */
  readonly registeredTools: readonly string[];
  /** Deterministic tier only: the per-run user prompt the agent received. */
  readonly prompt: string | null;
  /** Every progress event the run sent its connector, in order. */
  readonly progress: readonly AgentProgressEvent[];
  /** Fixture-server requests, counted outside the code under test. */
  readonly requests: readonly RequestLogEntry[];
  readonly searchCalls: readonly SearchCallRecord[];
  readonly searchPeakConcurrency: number;
  /** Confirmation requests the run raised (the harness denies every one). */
  readonly confirmationRequests: number;
  /** Browser launches, counted by the host-mapping decorator. */
  readonly browserLaunches: number;
  readonly rankSignals: readonly DomainRankSignal[];
  /** Hosts the HTTP mapping refused (should always be empty). */
  readonly egress: readonly string[];
  /** Run files that contain a planted canary, relative to the run directory. */
  readonly canaryHits: readonly string[];
  /**
   * The runtime-log safety scanner's findings: empty when safe, one message
   * when it refused a line, and null when no scanner was supplied.
   */
  readonly runtimeLogFindings: readonly string[] | null;
  readonly wallMs: number;
}

/**
 * The runtime-log safety scanner (`@yantra/test-helpers`'
 * `assertRuntimeLinesAreSafe`): throws on the first unsafe line. Injected,
 * because that package loads Vitest and the agentic runner runs under tsx.
 */
export type RuntimeLogScanner = (lines: readonly unknown[], canaries: readonly string[]) => void;

export type RunMode = 'deterministic' | 'agentic';

export interface RunScenarioOptions {
  readonly mode: RunMode;
  /** Directory the run store writes run directories under. Never removed by the runner. */
  readonly runRoot: string;
  /** Agentic mode: the model. The deterministic tier uses a fixed scripted identity. */
  readonly model?: AgentModelSelection;
  /** Agentic mode: model credentials. */
  readonly auth?: AgentAuthSelection;
  /** Test-only: replace the real model in agentic mode (the scorecard's self-test). */
  readonly agentOverride?: 'scripted';
  /** Scans `runtime.jsonl`; the deterministic tier always supplies it. */
  readonly runtimeLogScanner?: RuntimeLogScanner;
  /** Agentic mode: the CLI-resolved budgets. The scenario's own budgets override them. */
  readonly budgets?: Partial<AgentBudgetConfig>;
}

/** Planted where nothing should ever copy it from; found anywhere, it is a leak. */
export const RUN_CANARIES = Object.freeze({
  keychainSecret: 'sk-TASKFIDELITYCANARY0049abcdefgh',
});

const SCRIPTED_MODEL: AgentModelSelection = { provider: 'fixture', id: 'scripted-agent' };

/**
 * Run one scenario and capture everything a measure may read.
 *
 * The deterministic tier runs under a temporary `YANTRA_HOME` (with the path
 * cache reset before and after), so no developer state leaks in either
 * direction. The agentic tier keeps the developer's home, because that is
 * where the model credentials the CLI would use live; its run directories
 * still go under `runRoot`.
 *
 * @param scenario The scenario.
 * @param options Mode, run root, and (agentic) model selection.
 */
export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions,
): Promise<ScenarioRun> {
  const scripted = options.mode === 'deterministic' || options.agentOverride === 'scripted';
  const home = options.mode === 'deterministic' ? await isolatedHome() : null;
  const server = await serveTaskSites().catch((error: unknown) => {
    throw new HarnessSetupError(`The fixture server failed to bind: ${String(error)}`);
  });
  try {
    const search = new ScriptedSearchProvider({
      serps: scenario.serps,
      ...(scenario.faults === undefined ? {} : { faults: scenario.faults }),
      ...(scenario.searchProviderName === undefined ? {} : { name: scenario.searchProviderName }),
    });
    const rankSignals: DomainRankSignal[] = [];
    const rankSink: RankSignalSink = { record: (signal) => rankSignals.push(signal) };
    const egress = new EgressLog();
    const launches = new LaunchCounter();
    // The catalog comes from the scenario alone, never from the environment.
    const profile = resolveCommandTaskProfile(scenario.command, {
      browse: scenario.browse ?? true,
    });
    const connector = new SilentConnector();
    let agent: ScriptedAgentProvider | undefined;

    const leaves: Partial<EnvironmentLeaves> = {
      ...(options.mode === 'deterministic' ? { keychain: canaryKeychain() } : {}),
      ethicsConfig: defaultEthicsConfig,
      searchConfig: DEFAULT_SEARCH_CONFIG,
      blocklist: new BlocklistImpl(),
      createBrowserProvider: (browserOptions) =>
        hostMappedBrowserProvider(
          createSelectedBrowserProvider(browserOptions),
          server.port,
          launches,
        ),
      httpRequestFn: mappedRequestFn(server.port, egress),
      resolveSearchProvider: scriptedSearchLeaf(search),
    };

    // The run's budget clock: real time plus whatever a script's
    // `advance-clock` steps add, so a soft boundary can be crossed
    // deterministically.
    let clockOffsetMs = 0;
    const budgetNow = (): number => Date.now() + clockOffsetMs;
    const started = performance.now();
    const outcome = await runAgenticTask(
      {
        goal: scenario.goal,
        ...(scenario.saveAs === undefined ? {} : { saveAs: scenario.saveAs }),
        profile,
        model: scripted ? SCRIPTED_MODEL : (options.model ?? SCRIPTED_MODEL),
        auth: options.auth ?? { mode: 'managed' },
        ...(options.budgets === undefined && scenario.budgets === undefined
          ? {}
          : { budgets: { ...options.budgets, ...scenario.budgets } }),
        ambient: {
          grants: { location: true, screenshots: scenario.visionAssist === true },
          userLocation: locationOf(scenario.userLocation),
        },
        ...(scenario.screenshotsSuppressed === true ? { screenshotsSuppressed: true } : {}),
        connector,
      },
      {
        runStore: new LocalRunStore(options.runRoot),
        urlPolicyConfig: { requireHttps: false, maxUrlLength: 2048 },
        environmentLeaves: leaves,
        rankSink,
        ...(scripted
          ? {
              budgetNow,
              resolveModelImageInput: () => scenario.visionAssist === true,
              createProvider: (services) => {
                agent = new ScriptedAgentProvider(services, scenario.script, profile, (ms) => {
                  clockOffsetMs += ms;
                });
                return agent;
              },
            }
          : {}),
      },
    );
    const wallMs = performance.now() - started;

    const artifacts = await readArtifacts(outcome.runDir);
    const report: ScriptReport | null = agent?.report() ?? null;
    const requests = server.requests();
    const formState = latestFormStates(server.stateLog());
    const formInitialState = Object.fromEntries(
      [...server.stateLog()].sort((a, b) => b.seq - a.seq).map((state) => [state.page, state]),
    );
    let replay: ScenarioRun['replay'];
    if (
      scenario.saveAs !== undefined &&
      outcome.kind === 'published' &&
      outcome.promotion?.saved === true
    ) {
      const workflowStore = new FileWorkflowStore(workflowsRoot());
      const loaded = await workflowStore.load(scenario.saveAs);
      if (loaded.isOk) {
        server.reset();
        const replayProvider = hostMappedBrowserProvider(
          new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
          server.port,
        );
        const replayRun = await new RunOrchestrator({
          workflowStore,
          runStore: new LocalRunStore(join(options.runRoot, 'replay')),
          browserProvider: replayProvider,
          keychain: canaryKeychain(),
          sanitizer: new DefaultSanitizer(),
          ethicsGate: { check: () => Promise.resolve() },
          logger: {
            info: () => undefined,
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
          },
          llmClient: null,
        }).run({
          workflowName: scenario.saveAs,
          params: {},
          budgets: {},
          json: false,
          debug: false,
        });
        replay = {
          outcome: replayRun.kind,
          formState: latestFormStates(server.stateLog()),
          workflow: loaded.value,
        };
      }
    }
    return {
      scenario,
      mode: options.mode,
      outcome,
      runDir: outcome.runDir,
      artifacts,
      toolResults: report?.results ?? [],
      unreachable: report?.unreachable ?? [],
      skipped: report?.skipped ?? [],
      registeredTools: report?.registeredTools ?? [],
      prompt: report?.prompt ?? null,
      progress: connector.progress(),
      confirmationRequests: connector.confirmationRequests(),
      requests,
      formState,
      formInitialState,
      ...(replay === undefined ? {} : { replay }),
      surfaces: scenario.command === 'do' ? renderSurfaces(outcome) : null,
      searchCalls: search.calls(),
      searchPeakConcurrency: search.peakConcurrency(),
      browserLaunches: launches.count,
      rankSignals,
      egress: egress.hosts(),
      canaryHits: await canaryHits(outcome.runDir, [
        ...Object.values(RUN_CANARIES),
        ...(scenario.canaries ?? []),
      ]),
      runtimeLogFindings: runtimeLogVerdict(artifacts.runtime, options.runtimeLogScanner),
      wallMs,
    };
  } finally {
    await server.close();
    await home?.restore();
  }
}

/** Exercise the production connector twice, capturing human and JSON output independently. */
export function renderSurfaces(outcome: AgenticTaskOutcome): NonNullable<ScenarioRun['surfaces']> {
  const render = (json: boolean): string => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString('utf8'));
        done();
      },
    });
    const connector = new CLIConnectorIO(new TerminalRenderer(), {
      interactive: false,
      renderOpts: { json, debug: false, noColor: true, stream, errStream: stream },
    });
    connector.renderAgentOutcome(outcome);
    return chunks.join('');
  };
  return {
    firstLine: render(false).trimStart().split('\n')[0] ?? '',
    json: JSON.parse(render(true)) as unknown,
    exitCode: exitCodeForDoOutcome(outcome),
  };
}

/** A `YANTRA_HOME` for one scenario; restoring it resets the path cache and removes it. */
async function isolatedHome(): Promise<{ readonly restore: () => Promise<void> }> {
  const previous = process.env.YANTRA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-home-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  return {
    restore: async () => {
      if (previous === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = previous;
      resetPathCache();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** An in-memory keychain holding one canary secret nothing should ever copy. */
function canaryKeychain(): KeychainProvider {
  const values = new Map<string, string>([
    ['yantra/task-fidelity-canary', RUN_CANARIES.keychainSecret],
  ]);
  return {
    get: (service, account) => Promise.resolve(values.get(`${service}/${account}`) ?? null),
    set: (service, account, value) => {
      values.set(`${service}/${account}`, value);
      return Promise.resolve();
    },
    delete: (service, account) => Promise.resolve(values.delete(`${service}/${account}`)),
    list: (service) =>
      Promise.resolve(
        [...values.keys()]
          .filter((key) => key.startsWith(`${service}/`))
          .map((key) => ({ account: key.slice(service.length + 1) })),
      ),
    isAvailable: () => Promise.resolve(true),
  };
}

function locationOf(location: string | null): Sanitized<string> | null {
  if (location === null) return null;
  // The same chokepoint `resolveUserLocation` applies to a stored preference.
  const text = sanitize(location, 'public').text.trim();
  return text.length === 0 ? null : brandSanitized(text);
}

class SilentConnector implements AgentTaskConnector {
  public readonly interactive = false;

  private requests = 0;

  public requestConfirmation(
    _request: ConfirmationRequest,
    _signal: AbortSignal,
  ): Promise<'denied'> {
    // The harness never approves a protected action on a user's behalf.
    this.requests += 1;
    return Promise.resolve('denied');
  }

  /** How many confirmation requests the run raised. */
  public confirmationRequests(): number {
    return this.requests;
  }

  private readonly events: AgentProgressEvent[] = [];

  public emitAgentEvent(event: AgentProgressEvent): void {
    // Nothing is rendered; the events are kept so a measure can read them.
    this.events.push(event);
  }

  /** Every progress event received so far, in order. */
  public progress(): readonly AgentProgressEvent[] {
    return [...this.events];
  }

  public renderAgentOutcome(_outcome: AgenticTaskOutcome): void {
    // The outcome is returned to the runner directly.
  }
}

/**
 * Read every artifact a measure may use. Each is optional: an absent file is
 * `null`; a JSON file that does not parse is `null` and named in
 * `unparseableJson`; a JSONL line that does not parse is skipped and its line
 * number reported.
 *
 * @param runDir The completed run's directory.
 */
export async function readArtifacts(runDir: string): Promise<RunArtifacts> {
  const unparseableJson: string[] = [];
  const json = async (name: string): Promise<unknown> => {
    const text = await readText(join(runDir, name));
    if (text === null) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      unparseableJson.push(name);
      return null;
    }
  };
  const jsonl = async (name: string): Promise<JsonlArtifact | null> => {
    const text = await readText(join(runDir, name));
    return text === null ? null : parseJsonl(text);
  };
  const toolCalls = await jsonl('tool-calls.jsonl');
  const captures: Record<string, unknown> = {};
  const refs = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      if (
        (key === 'capture_ref' || key === 'analysis_capture_ref') &&
        typeof nested === 'string' &&
        /^cap-[0-9A-HJKMNP-TV-Z]{26}$/u.test(nested)
      )
        refs.add(nested);
      if (key === 'text' && typeof nested === 'string' && /^[{[]/u.test(nested.trim())) {
        try {
          collect(JSON.parse(nested) as unknown);
        } catch {
          /* Not embedded JSON; no references. */
        }
      } else collect(nested);
    }
  };
  collect(toolCalls?.lines);
  for (const ref of refs) {
    const text =
      (await readText(join(runDir, 'captures', `${ref}.txt`))) ??
      (await readText(join(runDir, 'captures', `${ref}.json`)));
    if (text === null) continue;
    try {
      captures[ref] = JSON.parse(text) as unknown;
    } catch {
      captures[ref] = text;
    }
  }
  return {
    manifest: await json('manifest.json'),
    brief: await json('brief.json'),
    document: await json('document.json'),
    toolCalls,
    captures,
    events: await jsonl('events.jsonl'),
    runtime: await jsonl('runtime.jsonl'),
    usage: await json('usage.json'),
    report: await readText(join(runDir, 'report.md')),
    runHealth: await json('run-health.json'),
    contract: await json('contract.json'),
    unparseableJson,
  };
}

/** Parse JSONL tolerantly: unparseable lines are reported by number, never thrown. */
export function parseJsonl(text: string): JsonlArtifact {
  const lines: unknown[] = [];
  const unparseable: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      lines.push(JSON.parse(line) as unknown);
    } catch {
      unparseable.push(index + 1);
    }
  });
  return { lines, unparseable };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Every file under `runDir` (relative path) whose bytes contain any canary. */
async function canaryHits(runDir: string, canaries: readonly string[]): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      // latin1 maps every byte to one code unit, so an ASCII canary is found
      // in any file, text or binary, without a decoding error.
      const text = await readFile(path, 'latin1');
      if (canaries.some((canary) => text.includes(canary))) hits.push(relative(runDir, path));
    }
  };
  await walk(runDir);
  return hits;
}

function runtimeLogVerdict(
  runtime: JsonlArtifact | null,
  scanner: RuntimeLogScanner | undefined,
): readonly string[] | null {
  if (scanner === undefined) return null;
  if (runtime === null) return ['runtime.jsonl is missing'];
  try {
    scanner(runtime.lines, Object.values(RUN_CANARIES));
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
