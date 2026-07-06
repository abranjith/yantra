/**
 * `yantra do "<goal>"` (alias: `discover`) — bounded ReAct discovery loop
 * (FEAT-020 TASK-004).
 *
 * The driver composes `@yantra/agent` (the proposer) and `@yantra/core` (the
 * executor, observation builder, ethics gate, browser provider) — the one
 * place in the codebase allowed to import both, per the layering rule.
 *
 * Loop, per cycle: `propose` (agent) → schema+semantic validate (protocol,
 * inside `propose`) → host-allowlist check (navigate only) → execute via the
 * real `Executor` (the confirmation gateway fires automatically for every
 * mutating step, since `normalizeProposal` force-flags them) → `observe`
 * (core) → append to `discovery.jsonl` → reduce session state → check
 * budgets/`done`. Terminates on `goal_met`, `goal_unreachable` (an honest
 * `done` with `goal_met: false`), `budget_exhausted`, `user_declined`
 * (a denied confirmation), or `aborted` (proposal re-prompt exhaustion / LLM
 * error). `--dry-run` short-circuits every mutating cycle with a synthetic
 * "not executed (dry-run)" observation — no step is ever dispatched.
 *
 * **Known limitation** (pre-existing gap, not introduced by this feature):
 * no code path anywhere in the repo constructs a real `InjectedScriptHost`
 * from a live browser page (`packages/core/src/executor/step-handlers/{click,
 * fill,extract,wait_for,assert}.ts` all require one and error without it —
 * confirmed by grep, zero production call sites assign `ctx.locatorHost`).
 * `navigate` works today (it only needs `ctx.page.goto`); click/fill/extract/
 * wait_for/assert do not yet work against a real page. This blocks `yantra
 * run` identically — it is not scoped to this feature. Tracked in
 * `.spec-lite/TODO.md`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  DISCOVERY_DEFAULT_MAX_REPROMPTS,
  appendCycle,
  expandAllowlist,
  initDiscoveryState,
  latestBudgetSnapshot,
  propose,
  type DiscoverySessionState,
} from '@yantra/agent';
import { AnthropicLLMClient, DEFAULT_BUDGET, NullLLMClient, type LLMClient } from '@yantra/agent';
import {
  BlocklistImpl,
  EthicsGateImpl,
  Executor,
  FileWorkflowStore,
  InteractiveConfirmationGateway,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  RobotsCacheImpl,
  buildObservation,
  createExecutionContext,
  loadEthicsConfig,
  mapRunOutcomeToStepOutcome,
  promoteDiscoverySession,
  runsRoot,
  validateCitations,
  workflowsRoot,
  writeBriefArtifacts,
  type BrowserSession,
  type ConfirmationGateway,
  type EthicsGate,
  type Extractor,
  type Logger,
  type Page,
  type RunOutcome,
} from '@yantra/core';
import type {
  Brief,
  BriefSource,
  DiscoveryCycle,
  DiscoveryDone,
  DiscoveryObservation,
  DiscoveryOutcome,
  DiscoveryProposal,
  Step,
} from '@yantra/protocol';
import { createBrief, generateUlid } from '@yantra/protocol';
import { CommanderError, Option, type Command } from 'commander';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface DoOptions {
  readonly json?: boolean;
  readonly dryRun?: boolean;
  readonly saveAs?: string;
  readonly maxSteps?: string;
  readonly budget?: string;
  readonly budgetMs?: string;
  readonly allowHost?: string[];
  readonly yesTo?: string;
}

/** Everything the driver loop needs, injectable for hermetic unit tests. */
export interface DoRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly clock: () => Date;
  readonly propose: typeof propose;
  /** Opens (or returns) the single live page the whole session reuses. */
  readonly openPage: () => Promise<Page>;
  /** Runs one cycle's 1-3 steps through the real executor. */
  readonly runCycle: (
    steps: readonly Step[],
    page: Page,
    runDir: string,
    taskId: string,
    runId: string,
  ) => Promise<RunOutcome>;
  readonly observe: typeof buildObservation;
  readonly extractor: Extractor;
  readonly gateway: ConfirmationGateway;
  readonly llmClient: LLMClient;
  readonly runsDir: string;
}

/** Terminal result of a discovery session. */
export interface DiscoveryRunResult {
  readonly state: DiscoverySessionState;
  readonly outcome: DiscoveryOutcome;
  readonly runId: string;
  readonly runDir: string;
  readonly brief: Brief | null;
}

/** Budget caps resolved from CLI flags (defaults per feature spec §1). */
export interface DiscoveryRunBudget {
  readonly maxSteps: number;
  readonly maxLlmCalls: number;
  readonly maxWallClockMs: number;
}

const DEFAULT_MAX_STEPS = 15;
const DEFAULT_MAX_LLM_CALLS = 20;
const DEFAULT_MAX_WALL_CLOCK_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerDoCommand(program: Command, runtime?: Partial<DoRuntime>): void {
  const action = async (goalArg: string, options: DoOptions): Promise<void> => {
    const resolved = runtimeWithDefaults(runtime);
    const budget: DiscoveryRunBudget = {
      maxSteps: clampInt(options.maxSteps, DEFAULT_MAX_STEPS, 1, 200),
      maxLlmCalls: clampInt(options.budget, DEFAULT_MAX_LLM_CALLS, 1, 200),
      maxWallClockMs: clampInt(options.budgetMs, DEFAULT_MAX_WALL_CLOCK_MS, 1_000, 3_600_000),
    };

    if (options.yesTo !== undefined && options.yesTo !== 'nothing') {
      resolved.stderr.write(
        '--yes-to only accepts "nothing" — nothing can ever be auto-granted.\n',
      );
      throw new CommanderError(1, 'yantra.do.invalid-flag', '--yes-to must be "nothing"');
    }

    try {
      const result = await runDiscoverySession(
        { goal: goalArg, dryRun: options.dryRun === true, allowHosts: options.allowHost ?? [] },
        budget,
        resolved,
      );

      if (options.json === true) {
        resolved.stdout.write(
          `${JSON.stringify({
            runId: result.runId,
            outcome: result.outcome,
            cycles: result.state.cycles.length,
            brief: result.brief,
          })}\n`,
        );
      } else {
        resolved.stdout.write(
          `\nDiscovery ${result.outcome} after ${result.state.cycles.length} cycle(s).\n`,
        );
        if (result.brief) {
          resolved.stdout.write(`\n${result.brief.overview}\n`);
        }
      }

      if (options.saveAs !== undefined && result.outcome === 'goal_met') {
        const store = new FileWorkflowStore(workflowsRoot());
        const promotion = await promoteDiscoverySession(result.state, {
          workflowName: options.saveAs,
          store,
        });
        if (promotion.isOk) {
          resolved.stdout.write(`Saved as workflow "${options.saveAs}".\n`);
        } else {
          resolved.stderr.write(`Could not save workflow: ${promotion.error.message}\n`);
        }
      }

      process.exit(exitCodeForOutcome(result.outcome));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolved.stderr.write(`do failed: ${message}\n`);
      throw new CommanderError(2, 'yantra.do.failed', message);
    }
  };

  program
    .command('do')
    .alias('discover')
    .description('Discovery mode: the agent works the live web toward a goal, with consent gates.')
    .argument('<goal>', 'the goal to accomplish')
    .addOption(new Option('--dry-run', 'validate proposals but never execute mutating steps'))
    .addOption(new Option('--save-as <name>', 'promote a successful path into a saved workflow'))
    .addOption(
      new Option('--max-steps <n>', 'maximum total steps').default(String(DEFAULT_MAX_STEPS)),
    )
    .addOption(
      new Option('--budget <n>', 'maximum LLM propose calls').default(
        String(DEFAULT_MAX_LLM_CALLS),
      ),
    )
    .addOption(
      new Option('--budget-ms <ms>', 'wall-clock budget in ms').default(
        String(DEFAULT_MAX_WALL_CLOCK_MS),
      ),
    )
    .addOption(
      new Option('--allow-host <host>', 'seed the host allowlist (repeatable)')
        .argParser(collect)
        .default([]),
    )
    .addOption(
      new Option(
        '--yes-to <value>',
        'only "nothing" is accepted — documents that nothing auto-grants',
      ),
    )
    .addOption(new Option('--json', 'emit JSON').default(false))
    .action(action);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// ---------------------------------------------------------------------------
// The driver loop
// ---------------------------------------------------------------------------

export async function runDiscoverySession(
  opts: { readonly goal: string; readonly dryRun: boolean; readonly allowHosts: readonly string[] },
  budget: DiscoveryRunBudget,
  runtime: DoRuntime,
): Promise<DiscoveryRunResult> {
  const runId = generateUlid();
  const taskId = generateUlid();
  const runDir = join(runtime.runsDir, runId);
  await mkdir(runDir, { recursive: true });

  const startedAt = runtime.clock().getTime();
  let state: DiscoverySessionState = initDiscoveryState({
    goal: opts.goal,
    hostAllowlist: [...opts.allowHosts],
  });

  const page = await runtime.openPage();
  let outcome: DiscoveryOutcome = 'aborted';
  let finalDone: DiscoveryDone | null = null;

  while (true) {
    const snapshot = latestBudgetSnapshot(state);
    const elapsedMs = runtime.clock().getTime() - startedAt;

    if (
      snapshot.steps_used >= budget.maxSteps ||
      snapshot.llm_calls_used >= budget.maxLlmCalls ||
      elapsedMs >= budget.maxWallClockMs
    ) {
      outcome = 'budget_exhausted';
      break;
    }

    const proposalResult = await runtime.propose(
      state,
      { client: runtime.llmClient, maxReprompts: DISCOVERY_DEFAULT_MAX_REPROMPTS },
      { runId, taskId, budget: DEFAULT_BUDGET },
    );

    if (!proposalResult.isOk) {
      outcome = 'aborted';
      await appendDiscoveryLog(runDir, { kind: 'propose_failed', error: proposalResult.error });
      break;
    }

    const proposal = proposalResult.value;

    if (proposal.done !== null) {
      finalDone = proposal.done;
    }

    const allowlistBlock = findDisallowedNavigate(proposal, state.hostAllowlist);
    let cycleObservation: DiscoveryObservation;

    if (allowlistBlock !== null) {
      const reason = `Navigate target "${allowlistBlock}" is outside the allowed hosts (${state.hostAllowlist.join(', ') || '(none yet)'}). Re-run with --allow-host ${allowlistBlock} to permit it.`;
      cycleObservation = await runtime.observe(
        page,
        { outcome: 'confirmation_denied', reason },
        { extractor: runtime.extractor },
      );
    } else if (opts.dryRun && hasMutatingStep(proposal)) {
      cycleObservation = await runtime.observe(
        page,
        { outcome: 'completed', reason: 'not executed (dry-run)' },
        { extractor: runtime.extractor },
      );
    } else {
      const runOutcome = await runtime.runCycle(proposal.steps, page, runDir, taskId, runId);
      const mapped = mapRunOutcomeToStepOutcome(runOutcome);
      cycleObservation = await runtime.observe(page, mapped, { extractor: runtime.extractor });

      if (mapped.outcome === 'confirmation_denied') {
        outcome = 'user_declined';
      }
    }

    const cycle: DiscoveryCycle = {
      index: state.cycles.length,
      proposal,
      validation: { verdict: 'accepted', reasons: [] },
      observation: cycleObservation,
      budget_after: {
        steps_used: snapshot.steps_used + proposal.steps.length,
        llm_calls_used: snapshot.llm_calls_used + 1,
        wall_clock_ms: runtime.clock().getTime() - startedAt,
        cost_usd: snapshot.cost_usd,
      },
    };
    state = appendCycle(state, cycle);
    await appendDiscoveryLog(runDir, { kind: 'cycle', cycle });

    if (outcome === 'user_declined') {
      break;
    }
    if (allowlistBlock !== null && state.hostAllowlist.length === 0 && state.cycles.length === 1) {
      // First-ever proposal targeted a host outside an empty allowlist — expand
      // it automatically so the session can proceed (bootstrap case only).
      state = expandAllowlist(state, [allowlistBlock]);
    }

    if (finalDone !== null) {
      outcome = finalDone.goal_met ? 'goal_met' : 'goal_unreachable';
      break;
    }
  }

  const brief = finalDone !== null ? buildDiscoveryBrief(state, taskId, runId, finalDone) : null;
  if (brief !== null) {
    await writeBriefArtifacts(runDir, brief).catch(() => null);
  }
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify(
      {
        run_id: runId,
        task_id: taskId,
        type: 'do',
        goal: opts.goal,
        outcome,
        cycles: state.cycles.length,
      },
      null,
      2,
    ),
    'utf8',
  );

  return { state, outcome, runId, runDir, brief };
}

/** Finds a proposed navigate step whose target host is outside the allowlist, if any. */
function findDisallowedNavigate(
  proposal: DiscoveryProposal,
  allowlist: readonly string[],
): string | null {
  for (const step of proposal.steps) {
    if (step.type !== 'navigate') continue;
    if (step.url.kind !== 'literal' || typeof step.url.value !== 'string') continue;
    try {
      const host = new URL(step.url.value).host;
      if (allowlist.length > 0 && !allowlist.includes(host)) {
        return host;
      }
      if (allowlist.length === 0) {
        // Nothing allowed yet — the very first navigate always needs a host to bootstrap from.
        return host;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function hasMutatingStep(proposal: DiscoveryProposal): boolean {
  return proposal.steps.some(
    (step) => step.type === 'navigate' || step.type === 'click' || step.type === 'fill',
  );
}

async function appendDiscoveryLog(runDir: string, entry: Record<string, unknown>): Promise<void> {
  const path = join(runDir, 'discovery.jsonl');
  await mkdir(runDir, { recursive: true });
  const { appendFile } = await import('node:fs/promises');
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Brief assembly (visited pages as sources, done.summary_md as overview)
// ---------------------------------------------------------------------------

export function buildDiscoveryBrief(
  state: DiscoverySessionState,
  taskId: string,
  runId: string,
  done: DiscoveryDone,
): Brief {
  const visitedUrls = [
    ...new Set(
      state.cycles.flatMap((cycle) => (cycle.observation !== null ? [cycle.observation.url] : [])),
    ),
  ];
  const now = new Date().toISOString();
  const sources: BriefSource[] = visitedUrls.map((url, index) => ({
    n: index + 1,
    url,
    final_url: null,
    host: safeHost(url),
    title: null,
    fetched_at: now,
    published_at: null,
  }));

  const draft = createBrief({
    task_id: taskId,
    title: state.goal,
    overview: done.summary_md,
    sources,
    metadata: { synthesis: 'deterministic', run_id: runId },
  });

  const { brief } = validateCitations(
    draft,
    { query: state.goal, docs: [], failures: [] },
    { strategy: 'deterministic' },
  );
  return brief;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

function exitCodeForOutcome(outcome: DiscoveryOutcome): number {
  switch (outcome) {
    case 'goal_met':
    case 'budget_exhausted':
      return 0;
    case 'user_declined':
    case 'handoff':
      return 4;
    case 'goal_unreachable':
    case 'aborted':
      return 2;
  }
}

// ---------------------------------------------------------------------------
// Default runtime wiring
// ---------------------------------------------------------------------------

function runtimeWithDefaults(runtime?: Partial<DoRuntime>): DoRuntime {
  return {
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    clock: runtime?.clock ?? (() => new Date()),
    propose: runtime?.propose ?? propose,
    openPage: runtime?.openPage ?? defaultOpenPage,
    runCycle: runtime?.runCycle ?? defaultRunCycle,
    observe: runtime?.observe ?? buildObservation,
    extractor: runtime?.extractor ?? new ReadabilityExtractor(),
    gateway: runtime?.gateway ?? new InteractiveConfirmationGateway(),
    llmClient: runtime?.llmClient ?? createDefaultLlmClient(),
    runsDir: runtime?.runsDir ?? runsRoot(),
  };
}

let cachedBrowserSession: BrowserSession | null = null;
let cachedPage: Page | null = null;

async function defaultOpenPage(): Promise<Page> {
  if (cachedPage !== null) {
    return cachedPage;
  }
  const profileStore = new LocalProfileStore({ logger: noopLogger });
  const browserProvider = new LocalBrowserProvider({ profileStore, logger: noopLogger });
  cachedBrowserSession = await browserProvider.launch({ profile: { kind: 'ephemeral' } });
  cachedPage = await cachedBrowserSession.newPage();
  return cachedPage;
}

async function defaultRunCycle(
  steps: readonly Step[],
  page: Page,
  runDir: string,
  taskId: string,
  runId: string,
): Promise<RunOutcome> {
  const ethicsConfig = await loadEthicsConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const robots = new RobotsCacheImpl(ethicsConfig.userAgent);
  const rateLimiter = new RateLimiterImpl(
    ethicsConfig.rateLimitDefault,
    ethicsConfig.rateLimitOverrides,
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  );
  const ethicsGate: EthicsGate = new EthicsGateImpl(
    blocklist,
    robots,
    rateLimiter,
    ethicsConfig.userAgent,
    {
      enforceRobotsTxt: ethicsConfig.robotsEnabled,
    },
  );

  const plan = {
    task_id: taskId,
    plan_id: generateUlid(),
    schema_version: '0.2' as const,
    default_scope: 'public' as const,
    steps: [...steps],
    outputs: [],
  };

  const ctx = createExecutionContext({
    runId,
    taskId,
    plan,
    runDir,
    ethics: ethicsGate,
    logger: noopLogger,
    confirmationGateway: new InteractiveConfirmationGateway(),
  });
  ctx.page = page;

  return new Executor().run(ctx);
}

function createDefaultLlmClient(): LLMClient {
  const provider = process.env.LLM_PROVIDER;
  if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    return new AnthropicLLMClient({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: 'claude-sonnet-4-6',
      budget: DEFAULT_BUDGET,
    });
  }
  return new NullLLMClient();
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
