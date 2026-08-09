/**
 * FEAT-027 e2e — the two-way bridge between the agentic runtime and the
 * deterministic workflow engine, against the real fixture site and system
 * Chrome.
 *
 * 1. Promotion round-trip (plan §11 case 8): a fake-agent run performs
 *    navigate→fill→click→extract; `--save-as` promotes the trace into a saved
 *    workflow; `yantra run` replays it green with no LLM.
 * 2. Invocation path: an agent run scripts `workflow_run` to list the catalog
 *    and run a saved workflow; the nested run replays with zero agent-session
 *    artifacts (LLM-free), and the parent audit joins to the nested run id.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildYantraWrappedTools,
  createBriefPublisher,
  runAgenticTask,
  type AgentEvent,
  type AgentProgressEvent,
  type AgentProvider,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionOptions,
  type AgentTaskConnector,
  type AgenticRunEnvironment,
  type AgenticTaskOutcome,
  type RunServices,
  type WrappedTool,
  type YantraToolResult,
} from '@yantra/agent';
import {
  AgentBrowserController,
  DefaultSanitizer,
  FileWorkflowStore,
  HttpFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  ScriptRegistry,
  promoteAgentTrace,
  type ConfirmationGateway,
  type ConfirmationOutcome,
  type EthicsGate,
  type KeychainProvider,
  type PromotableTraceStep,
} from '@yantra/core';
import {
  LocalRunStore,
  RunOrchestrator,
  exitCodeFor,
  type OrchestratorRunOutcome,
} from '@yantra/core/workflow/replay';
import { createBrief, type BriefSource, type ConfirmationRequest } from '@yantra/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serveFixtureSite, type FixtureServer } from './fixtures/serve.js';

type Scenario = (session: ScenarioSession) => Promise<void>;

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A keychain stub — the bridge workflows in this suite declare no secrets. */
const stubKeychain: KeychainProvider = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(true),
  list: () => Promise.resolve([]),
  isAvailable: () => Promise.resolve(true),
};

const permissiveEthics: EthicsGate = { check: () => Promise.resolve() };

function grantingGateway(): ConfirmationGateway {
  return {
    request: (request: ConfirmationRequest): Promise<ConfirmationOutcome> =>
      Promise.resolve({
        confirmation_id: request.confirmation_id,
        decision: 'granted',
        decided_at: new Date().toISOString(),
        decided_by: 'user_interactive',
      }),
  };
}

class FixtureConnector implements AgentTaskConnector {
  public readonly interactive = true;
  public readonly outcomes: AgenticTaskOutcome[] = [];

  public requestConfirmation(): Promise<'granted' | 'denied'> {
    return Promise.resolve('granted');
  }
  public readonly progress: AgentProgressEvent[] = [];
  public emitAgentEvent(event: AgentProgressEvent): void {
    this.progress.push(event);
  }
  public renderAgentOutcome(outcome: AgenticTaskOutcome): void {
    this.outcomes.push(outcome);
  }
}

class ScenarioProvider implements AgentProvider {
  public session: ScenarioSession | undefined;
  public constructor(
    private readonly services: RunServices,
    private readonly scenario: Scenario,
  ) {}
  public open(options: AgentSessionOptions): Promise<AgentSession> {
    this.session = new ScenarioSession(options, this.services, this.scenario);
    return Promise.resolve(this.session);
  }
}

class ScenarioSession implements AgentSession {
  public readonly id: string;
  public readonly logPath: string;
  public readonly authSource = 'managed' as const;

  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly tools: ReadonlyMap<string, WrappedTool>;
  private runIndex = 0;

  public constructor(
    options: AgentSessionOptions,
    services: RunServices,
    private readonly scenario: Scenario,
  ) {
    this.id = `scenario-${options.runId}`;
    this.logPath = join(options.runDir, 'agent', `${this.id}.jsonl`);
    this.tools = new Map(buildYantraWrappedTools(services).map((tool) => [tool.name, tool]));
  }

  public async run(_prompt: string): Promise<AgentRunResult> {
    if (this.runIndex === 0) await this.scenario(this);
    this.runIndex += 1;
    return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
  }
  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public abort(): Promise<void> {
    return Promise.resolve();
  }
  public close(): Promise<void> {
    return Promise.resolve();
  }
  public emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  public async call(toolName: string, input: unknown): Promise<YantraToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Missing scenario tool ${toolName}`);
    const callId = `${toolName}-${crypto.randomUUID()}`;
    this.emit({
      type: 'tool_started',
      callId,
      tool: toolName,
      input,
      at: new Date().toISOString(),
    });
    const result = await tool.execute(input, undefined);
    this.emit({
      type: 'tool_finished',
      callId,
      tool: toolName,
      output: result,
      isError: result.status !== 'ok',
      at: new Date().toISOString(),
    });
    return result;
  }
}

let fixtureSite: FixtureServer;
const roots: string[] = [];

beforeAll(async () => {
  fixtureSite = await serveFixtureSite();
}, 30_000);

afterAll(async () => {
  await fixtureSite.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

/** Build a bridge-capable environment: browser + a workflow store/runner. */
function bridgeEnvironment(input: {
  readonly runId: string;
  readonly runDir: string;
  readonly workflowStore: FileWorkflowStore;
  readonly nestedRunStore: LocalRunStore;
}): AgenticRunEnvironment {
  const browserController = new AgentBrowserController({
    runId: input.runId,
    browserProvider: new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
    maxDigestBytes: 8 * 1024,
  });
  return {
    browserController,
    workflowStore: input.workflowStore,
    domain: {
      search: {
        resolveProvider: () => Promise.resolve({ isOk: false, error: { message: 'unused' } }),
        resultCap: 5,
        fetchTop: 3,
      },
      fetch: {
        fetcher: new HttpFetcher({ maxBodyBytes: 1024 * 1024 }),
        extractor: new ReadabilityExtractor(),
        ethics: permissiveEthics,
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024 * 1024,
        captureThresholdBytes: 16 * 1024,
      },
      script: { registry: new ScriptRegistry() },
      publish: createBriefPublisher(input.runDir),
      workflow: {
        listCatalog: () => input.workflowStore.listCatalog(),
        run: async (runInput, ctx) => {
          const orchestrator = new RunOrchestrator({
            workflowStore: input.workflowStore,
            runStore: input.nestedRunStore,
            browserProvider: new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
            keychain: stubKeychain,
            sanitizer: new DefaultSanitizer(),
            ethicsGate: permissiveEthics,
            logger: noopLogger,
            confirmationGateway: ctx.confirmationGateway,
          });
          const loaded = await input.workflowStore.load(runInput.workflow);
          const stepCount = loaded.isOk ? loaded.value.steps.length : 0;
          const outcome: OrchestratorRunOutcome = await orchestrator.run({
            workflowName: runInput.workflow,
            params: runInput.params,
            budgets: {},
            json: false,
            debug: false,
          });
          if (outcome.kind === 'success') {
            return { ok: true, runId: outcome.runId, stepCount, outputs: outcome.outputs };
          }
          return {
            ok: false,
            errorCode: 'WORKFLOW_RUN_FAILED',
            message: `nested run ${outcome.kind}`,
            runId: outcome.runId,
            retryable: false,
          };
        },
      },
      browser: {
        controller: browserController,
        ethics: permissiveEthics,
        secretResolver: null,
        secretHosts: () => Promise.resolve([]),
        captureThresholdBytes: 16 * 1024,
      },
      rank: null,
    },
  };
}

describe('@no-llm FEAT-027 workflow bridge', () => {
  it('promotes a navigate→fill→click→extract run and replays it green with no LLM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-bridge-promote-'));
    roots.push(root);
    const workflowStore = new FileWorkflowStore(join(root, 'workflows'));
    const agentRunStore = new LocalRunStore(join(root, 'agent-runs'));
    const nestedRunStore = new LocalRunStore(join(root, 'nested-runs'));
    const connector = new FixtureConnector();

    const outcome = await runAgenticTask(
      {
        goal: 'Log in on the fixture form and read the result',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        allowedHosts: ['127.0.0.1'],
        saveAs: 'fixture-login',
        connector,
      },
      {
        runStore: agentRunStore,
        sanitizer: new DefaultSanitizer(),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        createEnvironment: (context) =>
          Promise.resolve(bridgeEnvironment({ ...context, workflowStore, nestedRunStore })),
        createProvider: (services) => new ScenarioProvider(services, promotionScenario()),
      },
    );

    // The run published and promotion saved a workflow.
    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;
    expect(outcome.promotion).toEqual({ saved: true, workflowName: 'fixture-login' });

    // trace.json is the raw record of what the run did, observations included:
    // promotion needs them to tell whether a run *ended* by reading the page.
    const trace = JSON.parse(await readFile(join(outcome.runDir, 'trace.json'), 'utf8')) as {
      steps: { kind: string }[];
    };
    expect(trace.steps.map((s) => s.kind)).toEqual([
      'navigate',
      'observe',
      'fill_element',
      'observe',
      'click',
      'observe',
      'extract',
    ]);

    // The saved workflow exists and has the four promoted steps. The three
    // mid-run observations are navigation aids, not data collection, so
    // promotion drops them and keeps only the terminal read.
    const saved = await workflowStore.load('fixture-login');
    expect(saved.isOk).toBe(true);
    if (!saved.isOk) return;
    expect(saved.value.steps.map((s) => s.verb)).toEqual([
      'navigate',
      'fill_element',
      'click',
      'extract',
    ]);
    // The terminal read is bound to an output, so the replay below reports the
    // data it captured instead of only a status.
    expect(saved.value.outputs).toEqual([
      { name: 'extracted_content_1', from: '{{ capture.extracted_content_1.rows[0] }}' },
    ]);

    // Replay it deterministically with LLM disabled — no llmClient is wired.
    const priorProvider = process.env.LLM_PROVIDER;
    process.env.LLM_PROVIDER = 'none';
    try {
      const replay = new RunOrchestrator({
        workflowStore,
        runStore: nestedRunStore,
        browserProvider: new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
        keychain: stubKeychain,
        sanitizer: new DefaultSanitizer(),
        ethicsGate: permissiveEthics,
        logger: noopLogger,
        confirmationGateway: grantingGateway(),
      });
      const replayOutcome = await replay.run({
        workflowName: 'fixture-login',
        params: {},
        budgets: {},
        json: false,
        debug: false,
      });
      expect(replayOutcome.kind).toBe('success');
      expect(exitCodeFor(replayOutcome)).toBe(0);
      // No agent session was involved in the deterministic replay.
      const replayRun = await nestedRunStore.getRun(replayOutcome.runId);
      expect(replayRun).not.toBeNull();
      if (replayRun) expect(await pathExists(join(replayRun.runDir, 'agent'))).toBe(false);
    } finally {
      if (priorProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = priorProvider;
    }
  }, 60_000);

  it('runs a saved workflow via workflow_run with an LLM-free nested run and audit linkage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-bridge-invoke-'));
    roots.push(root);
    const workflowStore = new FileWorkflowStore(join(root, 'workflows'));
    const agentRunStore = new LocalRunStore(join(root, 'agent-runs'));
    const nestedRunStore = new LocalRunStore(join(root, 'nested-runs'));

    // Pre-save a replayable workflow from a synthetic trace.
    const promoted = await promoteAgentTrace(catalogTrace(), {
      workflowName: 'catalog-flow',
      store: workflowStore,
    });
    expect(promoted.isOk).toBe(true);

    const outcome = await runAgenticTask(
      {
        goal: 'Choose and run a saved workflow',
        model: { provider: 'fixture', id: 'fixture-model' },
        auth: { mode: 'managed' },
        allowedHosts: ['127.0.0.1'],
        connector: new FixtureConnector(),
      },
      {
        runStore: agentRunStore,
        sanitizer: new DefaultSanitizer(),
        urlPolicyConfig: { maxUrlLength: 2048, requireHttps: false },
        createEnvironment: (context) =>
          Promise.resolve(bridgeEnvironment({ ...context, workflowStore, nestedRunStore })),
        createProvider: (services) => new ScenarioProvider(services, invocationScenario()),
      },
    );

    expect(outcome.kind).toBe('published');
    if (outcome.kind !== 'published') return;

    // The parent tool-calls.jsonl records the nested run id (audit join key).
    const toolCalls = await jsonLines(join(outcome.runDir, 'tool-calls.jsonl'));
    const runEnd = toolCalls.find(
      (entry) =>
        entry.tool === 'workflow_run' &&
        entry.phase === 'end' &&
        entry.status === 'ok' &&
        (entry.output_sanitized as { details?: { nested_run_id?: unknown } } | undefined)?.details
          ?.nested_run_id !== undefined,
    );
    expect(runEnd).toBeDefined();
    const nestedRunId = (runEnd?.output_sanitized as { details: { nested_run_id: string } }).details
      .nested_run_id;
    expect(typeof nestedRunId).toBe('string');

    // The nested run exists and carries zero agent-session artifacts (LLM-free).
    const nested = await nestedRunStore.getRun(nestedRunId);
    expect(nested).not.toBeNull();
    if (nested) {
      expect(await pathExists(join(nested.runDir, 'agent'))).toBe(false);
      expect(nested.manifest.status).toBe('completed');
    }
  }, 60_000);
});

/** Scenario: drive the browser tools so the trace has navigate→fill→click→extract. */
function promotionScenario(): Scenario {
  return async (session) => {
    await session.call('browser_navigate', { url: `${fixtureSite.baseUrl}/form.html` });
    let observed = parseModel(await session.call('browser_observe', {}));
    await session.call('browser_fill_element', {
      field: refByName(observed, 'Username'),
      value: { kind: 'literal', value: 'alice' },
    });
    observed = parseModel(await session.call('browser_observe', {}));
    const submitted = await session.call('browser_click', {
      ref: refByName(observed, 'Submit form'),
    });
    expect(submitted.status).toBe('ok');
    await session.call('browser_observe', {});
    await session.call('browser_extract', { kind: 'content' });
    await publish(session, [source(1, `${fixtureSite.baseUrl}/form.html`)]);
  };
}

/** Scenario: list the catalog, run the saved workflow, then publish. */
function invocationScenario(): Scenario {
  return async (session) => {
    const listed = await session.call('workflow_run', { mode: 'list' });
    expect(listed.status).toBe('ok');
    expect(listed.modelText).toContain('catalog-flow');
    const ran = await session.call('workflow_run', { mode: 'run', workflow: 'catalog-flow' });
    expect(ran.status).toBe('ok');
    expect(ran.modelText).toContain('completed');
    await publish(session, [source(1, `${fixtureSite.baseUrl}/form.html`)]);
  };
}

/** Synthetic trace equivalent to the promotion scenario (no protected click). */
function catalogTrace(): PromotableTraceStep[] {
  return [
    {
      kind: 'navigate',
      host: '127.0.0.1',
      url: `${fixtureSite.baseUrl}/form.html`,
      requires_confirmation: false,
    },
    {
      kind: 'fill',
      host: '127.0.0.1',
      locator: [{ kind: 'role', role: 'textbox', name: 'Username' }],
      value: { kind: 'literal', value: 'alice' },
      submit: false,
      requires_confirmation: false,
    },
    {
      kind: 'extract',
      host: '127.0.0.1',
      extractionKind: 'content',
      requires_confirmation: false,
    },
  ];
}

async function publish(session: ScenarioSession, sources: BriefSource[]): Promise<void> {
  const citations = sources.map((item) => `[${item.n}]`).join('');
  const brief = createBrief({
    task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    title: 'Bridge result',
    overview: `Fixture evidence was verified. ${citations}`,
    sources,
  });
  const result = await session.call('result_publish', { brief });
  expect(result.status).toBe('ok');
}

function source(n: number, url: string): BriefSource {
  return {
    n,
    url,
    final_url: null,
    host: new URL(url).host,
    title: `Fixture source ${n}`,
    excerpt: null,
    fetched_at: new Date().toISOString(),
    published_at: null,
  };
}

function parseModel(result: YantraToolResult): Record<string, unknown> {
  return JSON.parse(result.modelText) as Record<string, unknown>;
}

function refByName(observation: Record<string, unknown>, name: string): string {
  const refs = observation.interactables as { ref: string; name: string }[];
  const match = refs.find((item) => item.name === name);
  if (!match) throw new Error(`Missing fixture ref ${name}`);
  return match.ref;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function jsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
  try {
    return (await readFile(path, 'utf8'))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}
