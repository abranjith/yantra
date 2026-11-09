// @no-llm
/**
 * FEAT-063 acceptance, against the built packages: real CLI runs (`ask`,
 * `research`, `do`, `run`) in a sandboxed `YANTRA_HOME` each write a
 * `run-events.jsonl` that
 *
 * 1. has a counterpart for every live line the run printed (the spec's §2
 *    Counterpart table, mirrored below as a typed table);
 * 2. is gap-free (`seq` is exactly 1..N);
 * 3. ends in its only `run_outcome`, whose `exit_code` is the process exit code;
 * 4. never contains a canary credential placed in the goal or resolved from a
 *    workflow secret (keychain stub).
 *
 * Plus tail recovery on a finished run, and old run directories without the
 * file. The byte-exact terminal and `--json` output of these commands is pinned
 * by `apps/cli/tests/live-output-golden.spec.ts`.
 */
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import {
  DEFAULT_AGENT_BUDGETS,
  runAgenticTask,
  type AgentEvent,
  type AgentProvider,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionOptions,
  type AgenticRunEnvironment,
  type RunServices,
} from '@yantra/agent';
import { run, type CliRunOptions } from '@yantra/cli';
import {
  AskPipeline,
  DefaultSanitizer,
  DeterministicSynthesizer,
  FollowUpQueryGenerator,
  MarkdownReportBuilder,
  ResearchLoop,
  RunEventLog,
  ScriptRegistry,
  readRunEvents,
  resetPathCache,
  runsRoot,
  workflowsRoot,
  type BrowserProvider,
  type ExtractedArticle,
  type FetchedDoc,
  type SearchResult,
} from '@yantra/core';
import { RunOrchestrator, LocalRunStore } from '@yantra/core/workflow/replay';
import {
  createBrief,
  ok,
  type ConfirmationRequest,
  type RunEventKind,
  type RunEventRecordType,
  type WorkflowFile,
} from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureSearchService } from './fixtures/search-service.js';

const CANARY = 'sk-CANARYe2e0123456789abcdefghijk';
const SECRET_CANARY = 'ghp_SECRETCANARY0123456789abcdef';
const FIXED = '2026-11-01T12:00:00.000Z';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-e2e-run-events-'));
  vi.stubEnv('YANTRA_HOME', home);
  vi.stubEnv('LLM_PROVIDER', '');
  resetPathCache();
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

// ---------------------------------------------------------------------------
// The §2 Counterpart table, as the scenarios exercise it
// ---------------------------------------------------------------------------

/** One row of the spec's Counterpart table: a live line and its `RunEvent` kinds. */
interface CounterpartRow {
  readonly live: string;
  readonly kinds: readonly RunEventKind[];
}

const COUNTERPARTS = {
  goalEcho: { live: 'goal: "…" echo', kinds: ['goal_echo'] },
  warning: { live: 'warning: … advisories', kinds: ['run_warning'] },
  tool: {
    live: '[tool] summary / [tool] status — summary',
    kinds: ['tool_started', 'tool_finished'],
  },
  assistant: { live: 'assistant text stream', kinds: ['assistant_text'] },
  consent: {
    live: 'consent card and [y/N] prompt',
    kinds: ['intervention_raised', 'intervention_resolved'],
  },
  agentOutcome: {
    live: 'outcome first line / --json agent_outcome',
    kinds: ['run_outcome', 'artifact_saved'],
  },
  replayOutcome: { live: '✓/✗/⤺ Run <id>: <outcome>', kinds: ['run_outcome'] },
  brief: { live: 'Brief rendered at the end', kinds: ['artifact_saved', 'synthesis_completed'] },
} as const satisfies Record<string, CounterpartRow>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CommandRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCli(argv: readonly string[], options: CliRunOptions): Promise<CommandRun> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (s: string) => void) =>
    new Writable({
      write(chunk, _e, cb) {
        append(String(chunk));
        cb();
      },
    });
  const io = {
    stdout: sink((s) => (stdout += s)),
    stderr: sink((s) => (stderr += s)),
    env: {},
    isTty: false,
  };
  const withIo = Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, { ...io, ...(value as object) }]),
  ) as CliRunOptions;
  const exitCode = await run(argv, withIo);
  return { exitCode, stdout, stderr };
}

async function onlyRunDir(): Promise<string> {
  const entries = await readdir(runsRoot());
  expect(entries).toHaveLength(1);
  return join(runsRoot(), entries[0]!);
}

async function records(runDir: string): Promise<RunEventRecordType[]> {
  const out: RunEventRecordType[] = [];
  for await (const item of readRunEvents(join(runDir, 'run-events.jsonl'))) {
    if (item.status !== 'event') throw new Error(`unexpected ${item.status} line in the log`);
    out.push(item.record);
  }
  return out;
}

/** The four acceptance assertions shared by every scenario. */
async function expectAcceptance(
  runDir: string,
  exitCode: number,
  rows: readonly CounterpartRow[],
): Promise<RunEventRecordType[]> {
  const rs = await records(runDir);
  const kinds = new Set(rs.map((r) => r.event.kind));
  for (const row of rows) {
    for (const kind of row.kinds)
      expect({ live: row.live, kind, present: kinds.has(kind) }).toEqual({
        live: row.live,
        kind,
        present: true,
      });
  }
  expect(rs.map((r) => r.seq)).toEqual(rs.map((_, i) => i + 1));
  expect(rs.filter((r) => r.event.kind === 'run_outcome')).toHaveLength(1);
  expect(rs.at(-1)?.event).toMatchObject({ kind: 'run_outcome', exit_code: exitCode });
  const bytes = readFileSync(join(runDir, 'run-events.jsonl'), 'utf8');
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(SECRET_CANARY);
  return rs;
}

// ---------------------------------------------------------------------------
// Deterministic ask / research over local fixture pages
// ---------------------------------------------------------------------------

const PAGES: Record<string, string> = {
  one: 'Electric vehicles saw battery prices fall while charging networks expanded across regions this year.',
  two: 'Analysts tracked electric vehicle adoption figures and policy incentives for buyers in several markets.',
  three:
    'Automakers announced new affordable electric models and longer warranties on their battery packs.',
};
const idOf = (url: string): string => new URL(url).pathname.slice(1).split('-')[0] ?? 'one';
const rows = (q: string): SearchResult[] =>
  Object.keys(PAGES).map((id, rank) => ({
    url: `https://fixture.example/${id}-${q.length}?token=${CANARY}`,
    title: id,
    snippet: id,
    source: 'duckduckgo',
    rank,
    publishedAt: null,
  }));
const stages = {
  searchProvider: { name: 'duckduckgo' as const, search: (q: string) => Promise.resolve(rows(q)) },
  fetcher: {
    fetch: (url: string): Promise<FetchedDoc> =>
      Promise.resolve({
        url,
        finalUrl: url,
        fetchedAt: FIXED,
        contentType: 'text/html',
        html: `<p>${PAGES[idOf(url)] ?? ''}</p>`,
        statusCode: 200,
        fetchMode: 'http',
        elapsedMs: 5,
      }),
  },
  extractor: {
    extract: (doc: FetchedDoc): Promise<ExtractedArticle> =>
      Promise.resolve({
        url: doc.finalUrl,
        title: idOf(doc.finalUrl),
        byline: null,
        publishedAt: null,
        siteName: 'fixture.example',
        contentText: PAGES[idOf(doc.finalUrl)] ?? '',
        contentHtml: '',
        excerpt: '',
        lengthChars: 100,
      }),
  },
  ethicsGate: { checkUrl: () => Promise.resolve({ ok: true as const }) },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
};

const deterministicRuntimes = (): CliRunOptions => {
  const shared = {
    recordHistory: () => Promise.resolve(),
    resolveDefaults: () => Promise.resolve(new Map()),
  };
  return {
    askRuntime: {
      ...shared,
      createPipeline: () =>
        Promise.resolve(
          new AskPipeline({
            ...stages,
            cache: {
              get: () => Promise.resolve(null),
              put: () => Promise.resolve(),
              delete: () => Promise.resolve(),
            },
            synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
            runRootDir: runsRoot(),
          }),
        ),
    },
    researchRuntime: {
      ...shared,
      createLoop: () =>
        Promise.resolve(
          new ResearchLoop({
            ...stages,
            synthesizer: new DeterministicSynthesizer({ clock: () => new Date(FIXED) }),
            queryGen: new FollowUpQueryGenerator(),
            runRootDir: runsRoot(),
            budgetNow: () => 0,
          }),
        ),
    },
  };
};

describe('@no-llm run-events.jsonl acceptance (built packages)', () => {
  it('ask --no-llm: goal echo, phases, Brief artifacts, one outcome, no canary', async () => {
    const result = await runCli(
      ['ask', `electric vehicles ${CANARY}`, '--no-llm'],
      deterministicRuntimes(),
    );
    const runDir = await onlyRunDir();

    expect(result.exitCode).toBe(0);
    const rs = await expectAcceptance(runDir, result.exitCode, [
      COUNTERPARTS.goalEcho,
      COUNTERPARTS.brief,
    ]);
    expect(rs[0]?.event.kind).toBe('goal_echo');
    expect(rs.map((r) => r.event.kind)).toEqual(
      expect.arrayContaining([
        'search_completed',
        'source_fetched',
        'extract_completed',
        'synthesize_started',
        'receipt_written',
      ]),
    );
    expect(result.stderr).toContain('goal: "electric vehicles {{user:api_key:1}}"');
  });

  it('research --no-llm --no-browse: the advisory, per-hop phases and budget snapshots', async () => {
    const result = await runCli(
      ['research', `electric vehicles ${CANARY}`, '--no-llm', '--no-browse', '--depth', '2'],
      deterministicRuntimes(),
    );
    const runDir = await onlyRunDir();

    expect(result.exitCode).toBe(0);
    const rs = await expectAcceptance(runDir, result.exitCode, [
      COUNTERPARTS.goalEcho,
      COUNTERPARTS.warning,
      COUNTERPARTS.brief,
    ]);
    expect(rs.slice(0, 2).map((r) => r.event.kind)).toEqual(['run_warning', 'goal_echo']);
    expect(rs.some((r) => r.event.kind === 'budget_snapshot')).toBe(true);
    expect(rs.at(-1)?.event).toMatchObject({ stop_detail: expect.any(String) as string });
  });
});

// ---------------------------------------------------------------------------
// Agentic `do` over a scripted provider
// ---------------------------------------------------------------------------

class ScriptedSession implements AgentSession {
  public readonly id: string;
  public readonly logPath: string;
  public readonly authSource = 'managed' as const;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private index = 0;

  public constructor(
    private readonly options: AgentSessionOptions,
    private readonly services: RunServices,
  ) {
    this.id = `scripted-${options.runId}`;
    this.logPath = join(options.runDir, 'agent', `${this.id}.jsonl`);
  }

  public async run(): Promise<AgentRunResult> {
    if (this.index++ === 0) {
      const at = new Date().toISOString();
      this.emit({ type: 'assistant_text', text: 'Reading the fixture.', at });
      this.emit({ type: 'tool_started', tool: 'web_fetch', callId: 'c1', input: { url: 'x' }, at });
      this.emit({
        type: 'tool_finished',
        tool: 'web_fetch',
        callId: 'c1',
        output: { status: 'ok' },
        isError: false,
        at,
      });
      const request: ConfirmationRequest = {
        confirmation_id: '01J00000000000000000000000',
        run_id: this.options.runId,
        step_id: 'click-1',
        action_kind: 'click',
        host: 'shop.example',
        description: 'Place the order',
        expected_cost: null,
        consequence: 'irreversible',
        requested_at: at,
        timeout_ms: 30_000,
      };
      await this.services.confirmation?.gateway.request(request);
      const brief = createBrief({
        task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        title: 'Fixture',
        overview: 'Done.',
      });
      await Promise.all(
        ['json', 'md', 'html'].map((ext) =>
          writeFile(
            join(this.options.runDir, `brief.${ext}`),
            ext === 'json' ? JSON.stringify(brief) : 'Fixture',
          ),
        ),
      );
      this.emit({
        type: 'tool_finished',
        tool: 'result_publish',
        callId: 'c2',
        output: { status: 'ok' },
        isError: false,
        at,
      });
    }
    return { outcome: 'completed', stopReason: 'stop', usage: { turns: 1 } };
  }

  public subscribe(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public steer(): Promise<'queued' | 'idle'> {
    return Promise.resolve('idle');
  }

  public abort(): Promise<void> {
    return Promise.resolve();
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function scriptedEnvironment(): AgenticRunEnvironment {
  return {
    browserController: { teardown: () => Promise.resolve() },
    domain: {
      search: { service: fixtureSearchService(), resultCap: 3, fetchTop: 0 },
      fetch: {
        fetcher: { fetch: () => Promise.reject(new Error('unused')) },
        extractor: {} as never,
        ethics: { check: () => Promise.resolve() },
        allowedContentTypes: ['text/html'],
        maxContentBytes: 1024,
        captureThresholdBytes: 512,
      },
      script: { registry: new ScriptRegistry() },
      publish: { publish: () => Promise.reject(new Error('unused')) },
      browser: null,
      workflow: null,
      rank: null,
    },
  };
}

describe('@no-llm run-events.jsonl acceptance: do', () => {
  it('do: warning, tool rounds, consent wait, Brief artifacts and the outcome', async () => {
    const result = await runCli(
      ['do', `Log in with password=hunter2xyz and use ${CANARY}`, '--json'],
      {
        doRuntime: {
          recordHistory: () => Promise.resolve(),
          resolveDefaults: () => Promise.resolve(new Map()),
          resolveAgent: () =>
            Promise.resolve({
              mode: 'llm' as const,
              model: { provider: 'fixture', id: 'fixture-model' },
              auth: { mode: 'managed' as const },
              budgets: DEFAULT_AGENT_BUDGETS,
            }),
          runTask: (request, dependencies) =>
            runAgenticTask(request, {
              ...dependencies,
              runStore: new LocalRunStore(),
              sanitizer: new DefaultSanitizer(),
              createEnvironment: () => Promise.resolve(scriptedEnvironment()),
              createProvider: (services): AgentProvider => ({
                open: (options) => Promise.resolve(new ScriptedSession(options, services)),
              }),
            }),
        },
      },
    );
    const runDir = await onlyRunDir();

    const rs = await expectAcceptance(runDir, result.exitCode, [
      COUNTERPARTS.goalEcho,
      COUNTERPARTS.warning,
      COUNTERPARTS.tool,
      COUNTERPARTS.assistant,
      COUNTERPARTS.consent,
      COUNTERPARTS.agentOutcome,
    ]);
    expect(
      rs
        .slice(0, 2)
        .map((r) => r.event.kind)
        .sort(),
    ).toEqual(['goal_echo', 'run_warning']);
    expect(rs.find((r) => r.event.kind === 'intervention_resolved')?.event).toMatchObject({
      decision: 'timed_out',
      decided_by: 'timeout',
    });
    expect(readFileSync(join(runDir, 'report.md'), 'utf8')).toContain('- run-events.jsonl');
    expect(result.stdout).toContain('"kind":"agent_progress"');
  });
});

// ---------------------------------------------------------------------------
// Replay `run` of a fixture workflow with a keychain-stub secret
// ---------------------------------------------------------------------------

function fixtureWorkflow(): WorkflowFile {
  return {
    version: 1,
    name: 'fixture',
    description: null,
    security_class: 'public',
    recorded_with: null,
    params: {},
    secrets: ['site.token'],
    cookies: 'none',
    steps: [
      {
        id: 's1',
        verb: 'navigate',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: 'https://fixture.example/start',
      },
      {
        id: 's2',
        verb: 'navigate',
        scope: null,
        requires_confirmation: false,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: '{{secret:site.token}}',
      },
    ],
    outputs: [],
    outputs_unredacted: false,
    _unrecorded_frames: [],
    _locators: {},
  } as unknown as WorkflowFile;
}

describe('@no-llm run-events.jsonl acceptance: run', () => {
  it('run: mirrored lifecycle, artifacts and the outcome; the resolved secret never reaches the log', async () => {
    const visited: string[] = [];
    const page = {
      goto: (url: string) => {
        visited.push(url);
        return Promise.resolve(null);
      },
      url: () => visited.at(-1) ?? 'about:blank',
      close: () => Promise.resolve(),
    };
    const browserProvider = {
      launch: () =>
        Promise.resolve({
          id: 's',
          chrome: { majorVersion: 150 },
          profilePath: '',
          newPage: () => Promise.resolve(page),
          newIsolatedPage: () => Promise.resolve(page),
          close: () => Promise.resolve(),
          on: () => undefined,
        }),
    } as unknown as BrowserProvider;
    const keychain = {
      get: vi.fn(() => Promise.resolve(`https://fixture.example/secret?k=${SECRET_CANARY}`)),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve([{ account: 'site.token' }]),
      isAvailable: () => Promise.resolve(true),
    };
    await mkdir(workflowsRoot(), { recursive: true });
    await writeFile(join(workflowsRoot(), 'fixture.yaml'), 'version: 1\nname: fixture\n');

    const result = await runCli(['run', 'fixture', '--no-llm'], {
      replayRuntime: {
        recordHistory: () => Promise.resolve(),
        build: () =>
          Promise.resolve({
            close: () => undefined,
            orchestrator: new RunOrchestrator({
              workflowStore: { load: () => Promise.resolve(ok(fixtureWorkflow())) } as never,
              runStore: new LocalRunStore(),
              browserProvider,
              keychain,
              ethicsGate: { check: () => Promise.resolve() },
              logger: stages.logger,
            }),
          }),
      },
    });
    const runDir = await onlyRunDir();

    expect(keychain.get).toHaveBeenCalled();
    const rs = await expectAcceptance(runDir, result.exitCode, [COUNTERPARTS.replayOutcome]);
    const kinds = rs.map((r) => r.event.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(['task_started', 'step_started', 'artifact_saved']),
    );
    // Exactly one terminal lifecycle event is mirrored, whichever way the run ended.
    expect(kinds.filter((k) => k === 'task_completed' || k === 'task_failed')).toHaveLength(1);
    expect(readFileSync(join(runDir, 'events.jsonl'), 'utf8')).not.toContain(SECRET_CANARY);
  });
});

// ---------------------------------------------------------------------------
// Tail recovery and old run directories
// ---------------------------------------------------------------------------

describe('@no-llm run-events.jsonl recovery and compatibility', () => {
  it('a truncated tail on a finished run is cut on open and seq continues', async () => {
    await runCli(['ask', 'electric vehicles', '--no-llm'], deterministicRuntimes());
    const runDir = await onlyRunDir();
    const path = join(runDir, 'run-events.jsonl');
    const finished = await records(runDir);
    const size = statSync(path).size;
    appendFileSync(path, '{"schema_version":"1","seq":999,"run_id":"x","ev');

    // What FEAT-064's reconciler will do: open the run's log as its writer.
    const log = RunEventLog.open({ runDir, runId: finished[0]!.run_id });
    expect(statSync(path).size).toBe(size);
    const seq = log.append({
      kind: 'event_omitted',
      original_kind: 'reconciler_probe',
      bytes: 0,
      at: FIXED,
    });
    log.close();

    expect(seq).toBe(finished.length + 1);
    expect((await records(runDir)).map((r) => r.seq)).toEqual([...finished.map((r) => r.seq), seq]);
  });

  it('an old run directory without run-events.jsonl still builds its report', async () => {
    const runDir = join(runsRoot(), 'pre-feat-063-run');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'manifest.json'),
      JSON.stringify({ task_id: 't', type: 'ask', query: 'q', status: 'ok', started_at: FIXED }),
    );
    await writeFile(
      join(runDir, 'events.jsonl'),
      `${JSON.stringify({ kind: 'task_started', task_id: 't', at: FIXED })}\n`,
    );

    const report = await new MarkdownReportBuilder().build(runDir, 'completed');

    expect(report).toContain('## Audit Trail');
    expect(report).not.toContain('run-events.jsonl');
    const items: unknown[] = [];
    for await (const item of readRunEvents(join(runDir, 'run-events.jsonl'))) items.push(item);
    expect(items).toEqual([]);
  });
});
