// @no-llm
/**
 * Live-output goldens (FEAT-063 TASK-001).
 *
 * Every byte a run prints while it runs is pinned here before the renderers are
 * moved onto the `RunEvent` union, and stays pinned after: the acceptance item
 * "golden terminal and `--json` output is unchanged" is this file.
 *
 * Each scenario runs the real command handler (`executeCommand` over a
 * terminal context) in a sandboxed `YANTRA_HOME`. `ask` and `research` drive
 * the real deterministic pipeline over stub search, fetch and extract stages
 * with a fixed clock; `do` drives the connector exactly as the agent
 * orchestrator does (warning, every progress kind, consent, outcome); `run` and
 * `resume` use a stub orchestrator, because their live output is only the
 * outcome lines the command prints.
 *
 * Goldens live in `tests/fixtures/live-output/`: `<scenario>.stdout.txt` or
 * `<scenario>.stdout.ndjson` (`--json`) and `<scenario>.stderr.txt`, compared
 * byte for byte. A stream a scenario declares empty has no file and must stay
 * empty. To refresh deliberately, run with `YANTRA_UPDATE_LIVE_GOLDENS=1` and
 * review the diff; never run prettier over the directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import {
  AskPipeline,
  DeterministicSynthesizer,
  FollowUpQueryGenerator,
  ResearchLoop,
  resetPathCache,
  workflowsRoot,
  type AskCache,
  type ExtractedArticle,
  type FetchedDoc,
  type SearchResult,
} from '@yantra/core';
import type { OrchestratorRunOutcome, ResumePoint } from '@yantra/core/workflow/replay';
import type { Brief, ConfirmationRequest } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../src/adapters/terminal/terminal-adapter.js';
import { resolveAgentInvocation } from '../src/agent-options.js';
import { executeCommand } from '../src/execute.js';
import type { CliRunOptions } from '../src/program.js';

const GOLDEN_DIR = join(import.meta.dirname, 'fixtures', 'live-output');
const UPDATE = process.env.YANTRA_UPDATE_LIVE_GOLDENS === '1';
const FIXED_NOW = '2026-06-15T00:00:00.000Z';
const RUN_ID = 'run-fixed';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-live-golden-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});

afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/**
 * The one documented replacer. It removes only invocation identity: the
 * sandbox home (the absolute run-directory prefix, in native, forward-slash
 * and JSON-escaped spellings, with the path separators after it written as
 * `/` so one golden serves Windows, macOS and Linux) and generated run
 * identifiers (UUID run IDs and ULID task IDs). Every other byte is compared
 * as printed.
 */
export function normalizeLiveOutput(text: string, sandboxHome: string): string {
  return text
    .replaceAll(JSON.stringify(sandboxHome).slice(1, -1), '<home>')
    .replaceAll(sandboxHome, '<home>')
    .replaceAll(sandboxHome.replaceAll('\\', '/'), '<home>')
    .replace(/<home>[^\s"]*/g, (path) => path.replace(/\\\\|\\/g, '/'))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<run-id>')
    .replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ulid>');
}

interface Captured {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runCommand(argv: readonly string[], options: CliRunOptions): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const sink = (append: (chunk: string) => void): Writable =>
    new Writable({
      write(chunk, _encoding, callback) {
        append(String(chunk));
        callback();
      },
    });
  const context = createTerminalContext({
    env: {},
    cwd: home,
    isTty: false,
    stdout: sink((chunk) => (stdout += chunk)),
    stderr: sink((chunk) => (stderr += chunk)),
  });
  const result = await executeCommand(argv, context, options);
  return {
    stdout: normalizeLiveOutput(stdout, home),
    stderr: normalizeLiveOutput(stderr, home),
    exitCode: result.exitCode,
  };
}

/** Byte comparison against one golden file; returns the mismatch, if any. */
export function compareToGolden(actual: string, file: string): string | null {
  const expected = readFileSync(file);
  const bytes = Buffer.from(actual, 'utf8');
  if (expected.equals(bytes)) return null;
  const at = [...expected].findIndex((byte, index) => byte !== bytes[index]);
  return `${file} differs at byte ${at === -1 ? Math.min(expected.length, bytes.length) : at}`;
}

type Stream = 'stdout' | 'stderr';

function goldenPath(scenario: string, stream: Stream, json: boolean): string {
  const extension = stream === 'stdout' && json ? 'ndjson' : 'txt';
  return join(GOLDEN_DIR, `${scenario}.${stream}.${extension}`);
}

function assertGolden(
  scenario: string,
  captured: Captured,
  spec: { readonly json: boolean; readonly empty: readonly Stream[] },
): void {
  for (const stream of ['stdout', 'stderr'] as const) {
    const actual = captured[stream];
    if (spec.empty.includes(stream)) {
      expect({ scenario, stream, actual }).toEqual({ scenario, stream, actual: '' });
      continue;
    }
    const file = goldenPath(scenario, stream, spec.json);
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(file, actual, 'utf8');
      continue;
    }
    expect({ scenario, stream, empty: actual.length === 0 }).toEqual({
      scenario,
      stream,
      empty: false,
    });
    expect(compareToGolden(actual, file)).toBeNull();
  }
}

// ---------------------------------------------------------------------------
// Agentic `do`: the connector driven exactly as the orchestrator drives it
// ---------------------------------------------------------------------------

const consentRequest: ConfirmationRequest = {
  confirmation_id: '01J00000000000000000000000',
  run_id: RUN_ID,
  step_id: 'step-1',
  action_kind: 'click',
  host: 'shop.example',
  description: 'Place the order',
  expected_cost: { amount: 12.5, currency: 'USD' },
  consequence: 'irreversible',
  requested_at: FIXED_NOW,
  timeout_ms: 1000,
};

type DoScript = 'published' | 'handoff' | 'failed' | 'consent';

function runDirOf(): string {
  return join(home, 'runs', RUN_ID);
}

function terminalOutcome(script: DoScript, runDir: string): AgenticTaskOutcome {
  switch (script) {
    case 'published':
      return {
        kind: 'published',
        runId: RUN_ID,
        runDir,
        brief: {
          kind: 'brief',
          briefId: 'brief-fixed',
          jsonPath: join(runDir, 'brief.json'),
          markdownPath: join(runDir, 'brief.md'),
          htmlPath: join(runDir, 'brief.html'),
        },
        taskOutcome: 'partial',
        requirements: {
          met: 1,
          total: 2,
          unmet: [{ id: 'fill:quantity', label: 'quantity', reason: null }],
          satisfied: [{ id: 'fill:email', label: 'email' }],
          contractDeclared: true,
        },
        artifacts: [],
        captureSets: [
          {
            scope: 'viewport',
            parts: [captured(1, 1)],
            complete: true,
            labels: [],
          },
          {
            scope: 'full_page',
            parts: [captured(2, 1), captured(2, 2)],
            complete: false,
            labels: ['truncated'],
          },
          { scope: 'viewport', parts: [captured(3, 1)], complete: true, labels: [] },
          { scope: 'viewport', parts: [captured(4, 1)], complete: true, labels: [] },
        ],
        terminationReason: 'model_finished',
      };
    case 'handoff':
    case 'consent':
      return {
        kind: 'handoff',
        runId: RUN_ID,
        runDir,
        blocker: script === 'consent' ? 'Consent was denied.' : 'The site requires sign-in.',
        safestNextAction: 'Sign in manually, then start a fresh run.',
        terminationReason: 'handoff',
      };
    case 'failed':
      return {
        kind: 'failed',
        runId: RUN_ID,
        runDir,
        error: { code: 'AGENT_TOOL_FAILED', message: 'The browser closed unexpectedly.' },
        terminationReason: 'provider_failed',
      };
  }
}

function captured(
  set: number,
  part: number,
): AgenticTaskOutcome extends infer O
  ? O extends { readonly kind: 'published' }
    ? O['captureSets'][number]['parts'][number]
    : never
  : never {
  return {
    path: `screenshots/capture-${set}-abcdef012345${part > 1 ? `-p${part}` : ''}.png`,
    sha256: 'a'.repeat(64),
    bytes: 1024,
    width: 1280,
    height: 720,
    part,
  };
}

/** Every progress kind, in the order a real `do` run emits them. */
async function scriptedRun(
  script: DoScript,
  input: AgenticTaskRequest,
): Promise<AgenticTaskOutcome> {
  const connector = input.connector;
  connector.emitAgentWarning?.(
    'a credential-shaped value in the goal was replaced with [secret-1]',
  );
  const runDir = runDirOf();
  if (script === 'consent') {
    const decision = await connector.requestConfirmation(consentRequest, input.signal!);
    connector.emitAgentEvent({
      type: 'tool_finished',
      tool: 'browser_click',
      summary: decision === 'granted' ? 'ok' : 'denied: CONFIRMATION_DENIED',
      status: decision === 'granted' ? 'ok' : 'denied',
      durationMs: 3,
      at: FIXED_NOW,
    });
  } else {
    connector.emitAgentEvent({
      type: 'contract_declared',
      revision: 1,
      summary: 'fill the order form; capture a screenshot',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'capability_gap',
      item: 'artifact:screenshot:full_page',
      reason: 'suppressed_by_flag',
      summary: 'cannot deliver: full-page screenshot (screenshots are off for this run)',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'tool_started',
      tool: 'browser_navigate',
      summary: 'fields: url',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({ type: 'assistant_text', text: 'Opening the page. ', at: FIXED_NOW });
    connector.emitAgentEvent({
      type: 'assistant_text',
      text: 'It has\ttwo fields.\n',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'tool_finished',
      tool: 'browser_navigate',
      summary: 'ok',
      status: 'ok',
      durationMs: 412,
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'tool_finished',
      tool: 'browser_fill',
      summary: 'error: LOCATOR_NOT_FOUND',
      status: 'error',
      durationMs: null,
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'progress',
      items: [
        { id: 'fill:email', kind: 'fill', label: 'email', state: 'met', done: 1, total: 1 },
        {
          id: 'fill:quantity',
          kind: 'fill',
          label: 'quantity',
          state: 'pending',
          done: 0,
          total: 1,
        },
      ],
      summary: 'email filled; quantity pending',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'recovery',
      rung: 'steer',
      trigger: 'stalled',
      move: 'fill-remaining',
      summary: 'no task progress;\u001b[2J try the next supported step',
      at: FIXED_NOW,
    });
    connector.emitAgentEvent({
      type: 'contract_declared',
      revision: 2,
      summary: 'fill the order form',
      at: FIXED_NOW,
    });
  }
  const outcome = terminalOutcome(script, runDir);
  connector.renderAgentOutcome(outcome);
  return outcome;
}

function doRuntime(script: DoScript): CliRunOptions {
  return {
    doRuntime: {
      runTask: (input) => scriptedRun(script, input),
      recordHistory: () => Promise.resolve(),
      resolveDefaults: () => Promise.resolve(new Map()),
      resolveAgent: (name, opts, env, prefs) =>
        resolveAgentInvocation(name, opts, env, prefs, {
          probeCredential: () => Promise.resolve({ available: true, authSource: 'fixture' }),
        }),
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic `ask` / `research`: the real pipeline over stub stages
// ---------------------------------------------------------------------------

const ARTICLES: Record<string, string> = {
  one: 'AI news this week centered on a major research lab that released a new language model. The team reported the AI system improved reasoning accuracy by twelve percent. Officials confirmed wider availability soon.',
  two: 'In AI news, a startup raised forty-five million dollars to expand its coding assistant. The company said its AI model automates enterprise workflows. Reporters covered the funding round widely.',
  three:
    'AI news roundup: chipmakers unveiled faster processors built for AI model training. One vendor listed its flagship AI accelerator at 328 dollars. Analysts expect broader adoption after the holiday.',
};

const searchRows: SearchResult[] = ['one', 'two', 'three', 'blocked'].map((id, rank) => ({
  url: `https://example.com/${id}`,
  title: `Title ${id}`,
  snippet: id,
  source: 'duckduckgo',
  rank,
  publishedAt: null,
}));

const idOf = (url: string): string => url.split('/').pop() ?? 'x';

const stubStages = {
  searchProvider: {
    name: 'duckduckgo' as const,
    search: () => Promise.resolve(searchRows),
  },
  fetcher: {
    fetch: (url: string): Promise<FetchedDoc> =>
      Promise.resolve({
        url,
        finalUrl: url,
        fetchedAt: FIXED_NOW,
        contentType: 'text/html',
        html: `<html><main><article><p>${ARTICLES[idOf(url)] ?? ''}</p></article></main></html>`,
        statusCode: 200,
        fetchMode: 'http',
        elapsedMs: 20,
      }),
  },
  extractor: {
    extract: (doc: FetchedDoc): Promise<ExtractedArticle> => {
      const text = ARTICLES[idOf(doc.finalUrl)] ?? '';
      return Promise.resolve({
        url: doc.finalUrl,
        title: `Article ${idOf(doc.finalUrl)}`,
        byline: null,
        publishedAt: null,
        siteName: 'example.com',
        contentText: text,
        contentHtml: `<p>${text}</p>`,
        excerpt: text.slice(0, 120),
        lengthChars: text.length,
      });
    },
  },
  // One source is refused by the ethics gate so a failure notice is printed.
  ethicsGate: {
    checkUrl: (url: string) =>
      Promise.resolve(
        url.endsWith('/blocked')
          ? { ok: false as const, reason: 'robots' as const, detail: 'robots.txt disallows' }
          : { ok: true as const },
      ),
  },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
};

const emptyCache: AskCache = {
  get: () => Promise.resolve<Brief | null>(null),
  put: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const fixedClock = (): Date => new Date(FIXED_NOW);

function deterministicRuntime(credentialAvailable: boolean): CliRunOptions {
  const shared = {
    recordHistory: () => Promise.resolve(),
    resolveDefaults: () => Promise.resolve(new Map()),
    resolveAgent: (
      name: string,
      opts: Parameters<typeof resolveAgentInvocation>[1],
      env: NodeJS.ProcessEnv,
      prefs: Parameters<typeof resolveAgentInvocation>[3],
    ) =>
      resolveAgentInvocation(name, opts, env, prefs, {
        probeCredential: () =>
          Promise.resolve(
            credentialAvailable
              ? { available: true, authSource: 'fixture' }
              : { available: false, authSource: null },
          ),
      }),
  };
  return {
    askRuntime: {
      ...shared,
      createPipeline: () =>
        Promise.resolve(
          new AskPipeline({
            ...stubStages,
            cache: emptyCache,
            synthesizer: new DeterministicSynthesizer({ clock: fixedClock }),
            runRootDir: join(home, 'runs'),
            clock: fixedClock,
          }),
        ),
    },
    researchRuntime: {
      ...shared,
      createLoop: () =>
        Promise.resolve(
          new ResearchLoop({
            ...stubStages,
            synthesizer: new DeterministicSynthesizer({ clock: fixedClock }),
            queryGen: new FollowUpQueryGenerator(),
            runRootDir: join(home, 'runs'),
            clock: fixedClock,
            budgetNow: () => 0,
          }),
        ),
    },
  };
}

// ---------------------------------------------------------------------------
// Replay `run` / `resume`: the command's own outcome lines
// ---------------------------------------------------------------------------

function replayRuntime(outcome: OrchestratorRunOutcome): CliRunOptions {
  return {
    replayRuntime: {
      recordHistory: () => Promise.resolve(),
      loadResumePoint: () =>
        Promise.resolve({
          manifest: { workflowName: 'fixture', failureClass: undefined },
          runDir: runDirOf(),
        } as ResumePoint),
      build: () =>
        Promise.resolve({
          close: () => undefined,
          orchestrator: {
            run: () => Promise.resolve(outcome),
            resume: () => Promise.resolve(outcome),
          },
        }),
    },
  };
}

async function seedWorkflow(): Promise<void> {
  await mkdir(workflowsRoot(), { recursive: true });
  await writeFile(join(workflowsRoot(), 'fixture.yaml'), 'version: 1\nname: fixture\n');
  await writeFile(join(workflowsRoot(), 'fixture.locators.json'), '{}');
}

const replaySuccess: OrchestratorRunOutcome = {
  kind: 'success',
  runId: RUN_ID,
  outputs: { answer: 'Delivered Monday', rows: [{ date: '07/21', event: 'Delivered' }] },
};
const replayFailure = {
  kind: 'failure',
  runId: RUN_ID,
  failureClass: 'locator_not_found',
  failureDetail: {
    failureClass: 'locator_not_found',
    stepId: '',
    message: 'Run failed with class: locator_not_found',
  },
} as OrchestratorRunOutcome;
const replayHandoff: OrchestratorRunOutcome = {
  kind: 'aborted',
  runId: RUN_ID,
  reason: 'user-handoff',
};

// ---------------------------------------------------------------------------
// Scenario table
// ---------------------------------------------------------------------------

interface Scenario {
  readonly name: string;
  readonly argv: readonly string[];
  readonly runtime: () => CliRunOptions;
  readonly exitCode: number;
  readonly json: boolean;
  readonly empty: readonly Stream[];
  readonly setup?: () => Promise<void>;
}

const GOAL = 'buy "2" widgets for under $40';

export const LIVE_OUTPUT_SCENARIOS: readonly Scenario[] = [
  {
    name: 'do.published.terminal',
    argv: ['do', GOAL],
    runtime: () => doRuntime('published'),
    exitCode: 2,
    json: false,
    empty: [],
  },
  {
    name: 'do.published.json',
    argv: ['do', GOAL, '--json'],
    runtime: () => doRuntime('published'),
    exitCode: 2,
    json: true,
    empty: [],
  },
  {
    name: 'do.handoff.terminal',
    argv: ['do', GOAL],
    runtime: () => doRuntime('handoff'),
    exitCode: 4,
    json: false,
    empty: [],
  },
  {
    name: 'do.handoff.json',
    argv: ['do', GOAL, '--json'],
    runtime: () => doRuntime('handoff'),
    exitCode: 4,
    json: true,
    empty: [],
  },
  {
    name: 'do.failed.terminal',
    argv: ['do', GOAL],
    runtime: () => doRuntime('failed'),
    exitCode: 2,
    json: false,
    empty: [],
  },
  {
    name: 'do.failed.json',
    argv: ['do', GOAL, '--json'],
    runtime: () => doRuntime('failed'),
    exitCode: 2,
    json: true,
    empty: [],
  },
  {
    // `--json` is non-interactive: the consent request is denied without a prompt.
    name: 'do.consent-denied.json',
    argv: ['do', GOAL, '--json'],
    runtime: () => doRuntime('consent'),
    exitCode: 4,
    json: true,
    empty: [],
  },
  {
    name: 'ask.no-llm.terminal',
    argv: ['ask', 'ai news', '--no-llm'],
    runtime: () => deterministicRuntime(true),
    exitCode: 0,
    json: false,
    empty: [],
  },
  {
    name: 'ask.no-llm.json',
    argv: ['ask', 'ai news', '--no-llm', '--json'],
    runtime: () => deterministicRuntime(true),
    exitCode: 0,
    json: true,
    empty: [],
  },
  {
    name: 'ask.model-unavailable.terminal',
    argv: ['ask', 'ai news'],
    runtime: () => deterministicRuntime(false),
    exitCode: 0,
    json: false,
    empty: [],
  },
  {
    name: 'ask.template-guard.terminal',
    argv: ['ask', 'ai news', '--no-llm', '--template', 'fixture'],
    runtime: () => deterministicRuntime(true),
    exitCode: 1,
    json: false,
    empty: ['stdout'],
  },
  {
    name: 'research.no-llm.terminal',
    argv: ['research', 'ai news', '--no-llm', '--depth', '2'],
    runtime: () => deterministicRuntime(true),
    exitCode: 0,
    json: false,
    empty: [],
  },
  {
    name: 'research.no-llm.json',
    argv: ['research', 'ai news', '--no-llm', '--json'],
    runtime: () => deterministicRuntime(true),
    exitCode: 0,
    json: true,
    empty: [],
  },
  {
    name: 'research.no-browse-warning.terminal',
    argv: ['research', 'ai news', '--no-llm', '--no-browse', '--depth', '1'],
    runtime: () => deterministicRuntime(true),
    exitCode: 0,
    json: false,
    empty: [],
  },
  {
    name: 'research.model-unavailable.json',
    argv: ['research', 'ai news', '--json', '--depth', '1'],
    runtime: () => deterministicRuntime(false),
    exitCode: 0,
    json: true,
    empty: [],
  },
  {
    name: 'run.success.terminal',
    argv: ['run', 'fixture', '--no-llm'],
    runtime: () => replayRuntime(replaySuccess),
    exitCode: 0,
    json: false,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'run.success.json',
    argv: ['run', 'fixture', '--no-llm', '--json'],
    runtime: () => replayRuntime(replaySuccess),
    exitCode: 0,
    json: true,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'run.failure.terminal',
    argv: ['run', 'fixture', '--no-llm'],
    runtime: () => replayRuntime(replayFailure),
    exitCode: 2,
    json: false,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'run.failure.json',
    argv: ['run', 'fixture', '--no-llm', '--json'],
    runtime: () => replayRuntime(replayFailure),
    exitCode: 2,
    json: true,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'run.handoff.terminal',
    argv: ['run', 'fixture', '--no-llm'],
    runtime: () => replayRuntime(replayHandoff),
    exitCode: 4,
    json: false,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'resume.success.terminal',
    argv: ['resume', RUN_ID, '--no-llm'],
    runtime: () => replayRuntime(replaySuccess),
    exitCode: 0,
    json: false,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
  {
    name: 'resume.success.json',
    argv: ['resume', RUN_ID, '--no-llm', '--json'],
    runtime: () => replayRuntime(replaySuccess),
    exitCode: 0,
    json: true,
    empty: ['stderr'],
    setup: seedWorkflow,
  },
];

describe('@no-llm live CLI output goldens', () => {
  it.each(LIVE_OUTPUT_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    '%s is byte-identical to its golden',
    async (_name, scenario) => {
      await scenario.setup?.();
      const captured = await runCommand(scenario.argv, scenario.runtime());

      expect(captured.exitCode).toBe(scenario.exitCode);
      assertGolden(scenario.name, captured, scenario);
    },
    30_000,
  );
});

describe('@no-llm live-output golden meta-checks', () => {
  it('has a non-empty golden for every non-empty scenario stream', () => {
    const missing: string[] = [];
    for (const scenario of LIVE_OUTPUT_SCENARIOS) {
      for (const stream of ['stdout', 'stderr'] as const) {
        if (scenario.empty.includes(stream)) continue;
        const file = goldenPath(scenario.name, stream, scenario.json);
        if (!existsSync(file) || readFileSync(file).length === 0) missing.push(file);
      }
    }

    expect(missing).toEqual([]);
  });

  it('has no orphan golden file without a scenario', async () => {
    const { readdir } = await import('node:fs/promises');
    const expected = new Set(
      LIVE_OUTPUT_SCENARIOS.flatMap((scenario) =>
        (['stdout', 'stderr'] as const)
          .filter((stream) => !scenario.empty.includes(stream))
          .map((stream) => goldenPath(scenario.name, stream, scenario.json)),
      ),
    );
    const present = (await readdir(GOLDEN_DIR)).map((file) => join(GOLDEN_DIR, file));

    expect(present.filter((file) => !expected.has(file))).toEqual([]);
  });

  it('fails the comparison on a one-byte change in a rendered string', async () => {
    const scenario = LIVE_OUTPUT_SCENARIOS.find((s) => s.name === 'do.published.terminal')!;
    const captured = await runCommand(scenario.argv, scenario.runtime());
    const file = goldenPath(scenario.name, 'stderr', false);
    // `understood:` → `understood;` — one byte, the shape a renderer edit takes.
    const mutated = captured.stderr.replace('understood:', 'understood;');

    expect(mutated).not.toBe(captured.stderr);
    expect(compareToGolden(captured.stderr, file)).toBeNull();
    expect(compareToGolden(mutated, file)).toMatch(/differs at byte \d+/);
  });

  it('normalizes only the sandbox home and generated run identities', () => {
    const sandbox = join(tmpdir(), 'sandbox-home');
    const text = `${join(sandbox, 'runs', 'x')} 0f8fad5b-d9cb-469f-a165-70867728950e 01J00000000000000000000000 kept`;

    expect(normalizeLiveOutput(text, sandbox)).toBe('<home>/runs/x <run-id> <ulid> kept');
  });

  it('writes separators after the home prefix as forward slashes, JSON-escaped too', () => {
    const sandbox = 'C:\\sandbox';
    const json = JSON.stringify({ runDir: 'C:\\sandbox\\runs\\x', other: 'a\\b' });

    expect(normalizeLiveOutput(json, sandbox)).toBe('{"runDir":"<home>/runs/x","other":"a\\\\b"}');
  });
});
