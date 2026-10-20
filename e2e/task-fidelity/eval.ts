/**
 * `pnpm eval:tasks`: the task-fidelity agentic tier (FEAT-049 TASK-009).
 *
 * Runs each agentic scenario with a real model, `--runs` times, sequentially
 * (runs never share a fixture server, and cost stays legible), scores every
 * run, and writes a schema-validated `scorecard.json` plus `scorecard.md`.
 * Dev-only and on demand: it is not a `*.spec.ts`, so `pnpm test` never runs
 * it, and its scores are observational — the process exits 0 whenever the
 * scorecard was written, whatever the scores (plan §11 ⚠).
 *
 * Model flags use the shared agentic spelling exactly (`--provider`,
 * `--model`, `--thinking`, `--auth-secret`), and selection resolves through
 * the CLI's own resolver: flag > environment > profile > pinned default.
 *
 * Exit codes follow the CLI: 0 complete, 1 usage, 2 execution, 3 environment
 * (missing credentials before startup, or provider unavailability). Completed
 * runs are checkpointed before the next request, including on interruption.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  AgentAuthUnavailableError,
  AgentStartupError,
  PROMPT_VERSION,
  type AgentAuthSelection,
  type AgentBudgetConfig,
  type AgentModelSelection,
} from '@yantra/agent';
import {
  loadEffectivePreferences,
  resolveAgentInvocation,
  type AgentInvocation,
  type AgentModelOptions,
} from '@yantra/cli';

import { runScenario, type ScenarioRun } from './runner.js';
import type { Scenario } from './scenario.js';
import { scenariosFor } from './scenarios/index.js';
import { renderScorecardMarkdown } from './score/render-md.js';
import {
  RunScoreSchema,
  BaselineSchema,
  ScoreCardSchema,
  baselineOf,
  type RunScore,
  type ScoreCard,
  type ScenarioScore,
} from './score/scorecard-schema.js';
import { median, scoreRun, stability } from './score/scorer.js';

const harnessRoot = dirname(fileURLToPath(import.meta.url));

/** The shared agentic model flags, spelled exactly as the CLI registers them. */
export const MODEL_FLAGS = ['--provider', '--model', '--thinking', '--auth-secret'] as const;

/** Parsed `pnpm eval:tasks` options. */
export interface EvalOptions extends AgentModelOptions {
  readonly phase?: 'before' | 'after';
  readonly suite?: 'do-benchmark';
  /** Scenario ids; empty selects every agentic scenario. */
  readonly scenarios: readonly string[];
  readonly runs: number;
  /** Output directory; null selects `e2e/task-fidelity/.out/<UTC timestamp>/`. */
  readonly out: string | null;
  /** Print the scorecard JSON to stdout. */
  readonly json: boolean;
}

/** A command-line mistake: exit 1. */
export class EvalUsageError extends Error {
  public override readonly name = 'EvalUsageError';
}

/** Provider access failed; preserve measured runs and stop without scoring the outage. */
export class EvalProviderUnavailableError extends Error {
  public override readonly name = 'EvalProviderUnavailableError';
}

/**
 * Parse `pnpm eval:tasks` arguments. Unknown flags are refused, as the CLI
 * refuses them.
 *
 * @param argv Arguments after the script name.
 */
export function parseEvalArgs(argv: readonly string[]): EvalOptions {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        provider: { type: 'string' },
        model: { type: 'string' },
        thinking: { type: 'string' },
        'auth-secret': { type: 'string' },
        scenario: { type: 'string', multiple: true },
        suite: { type: 'string' },
        phase: { type: 'string' },
        runs: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new EvalUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  if (values.phase !== undefined && values.phase !== 'before' && values.phase !== 'after')
    throw new EvalUsageError('--phase must be before or after');
  if (values.suite !== undefined && values.suite !== 'do-benchmark')
    throw new EvalUsageError(`Unknown suite "${values.suite}".`);
  if (values.suite !== undefined && values.scenario !== undefined)
    throw new EvalUsageError('--suite cannot be combined with --scenario.');
  const runs = values.runs === undefined ? 3 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new EvalUsageError('--runs must be a positive integer.');
  }
  return {
    ...(values.phase === undefined ? {} : { phase: values.phase }),
    ...(values.suite === undefined ? {} : { suite: values.suite }),
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values.thinking === undefined ? {} : { thinking: values.thinking }),
    ...(values['auth-secret'] === undefined ? {} : { authSecret: values['auth-secret'] }),
    scenarios: values.scenario ?? [],
    runs,
    out: values.out ?? null,
    json: values.json === true,
  };
}

/** Injectable boundaries for the eval's self-test. */
export interface EvalDependencies {
  /** Resolves model, credentials, and budgets; defaults to the CLI's resolver. */
  readonly resolveInvocation?: (options: AgentModelOptions) => Promise<AgentInvocation>;
  /** Runs one scenario; defaults to {@link runScenario}. */
  readonly runScenario?: typeof runScenario;
  /** Test-only: drive every run with the scripted agent instead of the model. */
  readonly agentOverride?: 'scripted';
  readonly stderr?: (line: string) => void;
  readonly now?: () => Date;
}

/** What an evaluation produced. */
export interface EvalResult {
  readonly card: ScoreCard;
  readonly outDir: string;
  readonly markdown: string;
}

/**
 * Run the agentic tier, checkpointing its scorecard after each completed run.
 *
 * @throws {EvalUsageError} for an unknown scenario or a no-LLM environment.
 * @throws {AgentAuthUnavailableError} when no model credential is available —
 *   before any fixture server starts.
 * @throws {EvalProviderUnavailableError} after saving completed runs when the provider is unavailable.
 */
export async function evaluate(
  options: EvalOptions,
  deps: EvalDependencies = {},
): Promise<EvalResult> {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const scenarios = selectScenarios(options.scenarios).filter(
    (scenario) => options.suite === undefined || scenario.suite === options.suite,
  );
  const selection = await resolveSelection(options, deps);

  const outDir = resolve(options.out ?? join(harnessRoot, '.out', timestamp(now())));
  const runRoot = join(outDir, 'runs');
  await mkdir(runRoot, { recursive: true });
  stderr(
    `${scenarios.length} scenarios × ${options.runs} runs = ${scenarios.length * options.runs} ` +
      `agentic runs with ${selection.model.provider}/${selection.model.id} (prompt ${PROMPT_VERSION})`,
  );

  const run = deps.runScenario ?? runScenario;
  const scored: ScenarioScore[] = [];
  const measuredSha = gitSha();
  let totalWallMs = 0;
  const checkpoint = async (progress: readonly ScenarioScore[]): Promise<EvalResult> => {
    const card = ScoreCardSchema.parse({
      ...(options.phase === undefined ? {} : { benchmark_phase: options.phase }),
      schema_version: 1,
      generated_at: now().toISOString(),
      git_sha: measuredSha,
      prompt_version: PROMPT_VERSION,
      model: {
        provider: selection.model.provider,
        id: selection.model.id,
        thinking: selection.model.thinking ?? null,
      },
      runs_per_scenario: options.runs,
      scenarios: [...progress],
      totals: totals(progress, totalWallMs),
    } satisfies ScoreCard);
    const markdown = renderScorecardMarkdown(card);
    const baseline = BaselineSchema.parse(baselineOf(card));
    for (const [file, content] of [
      ['scorecard.json', `${JSON.stringify(card, null, 2)}\n`],
      ['scorecard.md', markdown],
      ['baseline.json', `${JSON.stringify(baseline, null, 2)}\n`],
    ] as const) {
      const path = join(outDir, file);
      await writeFile(`${path}.tmp`, content, 'utf8');
      await rename(`${path}.tmp`, path);
    }
    return { card, outDir, markdown };
  };
  await checkpoint([]);
  for (const scenario of scenarios) {
    const runs: RunScore[] = [];
    for (let index = 1; index <= options.runs; index += 1) {
      const result = await run(scenario, {
        mode: 'agentic',
        runRoot,
        model: selection.model,
        auth: selection.auth,
        budgets: selection.budgets,
        ...(deps.agentOverride === undefined ? {} : { agentOverride: deps.agentOverride }),
      });
      if (
        result.outcome.kind === 'failed' &&
        result.outcome.error.code === 'AGENT_PROVIDER_UNAVAILABLE'
      ) {
        throw new EvalProviderUnavailableError(
          `${result.outcome.error.message} Completed runs are saved in ${outDir}.`,
        );
      }
      totalWallMs += result.wallMs;
      const score = runScore(result, scenario);
      runs.push(score);
      await checkpoint([...scored, { id: scenario.id, runs, aggregate: aggregate(runs) }]);
      stderr(
        `${scenario.id} ${index}/${options.runs} · ${result.outcome.kind} · ` +
          `${score.cost.turns ?? '?'} turns · ${Math.round(result.wallMs / 1000)} s`,
      );
    }
    scored.push({ id: scenario.id, runs, aggregate: aggregate(runs) });
  }

  const result = await checkpoint(scored);
  stderr(`scorecard written to ${outDir}`);
  return result;
}

function selectScenarios(ids: readonly string[]): readonly Scenario[] {
  const catalogue = scenariosFor('agentic');
  if (ids.length === 0) return catalogue;
  return ids.map((id) => {
    const found = catalogue.find((scenario) => scenario.id === id);
    if (found === undefined) {
      throw new EvalUsageError(
        `Unknown agentic scenario "${id}". Known: ${catalogue.map((scenario) => scenario.id).join(', ')}.`,
      );
    }
    return found;
  });
}

async function resolveSelection(
  options: EvalOptions,
  deps: EvalDependencies,
): Promise<{
  readonly model: AgentModelSelection;
  readonly auth: AgentAuthSelection;
  readonly budgets: Partial<AgentBudgetConfig>;
}> {
  if (deps.agentOverride === 'scripted') {
    return {
      model: { provider: 'fixture', id: 'scripted-agent' },
      auth: { mode: 'managed' },
      budgets: {},
    };
  }
  const modelOptions: AgentModelOptions = {
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.authSecret === undefined ? {} : { authSecret: options.authSecret }),
  };
  const invocation = await (deps.resolveInvocation ?? defaultResolveInvocation)(modelOptions);
  if (invocation.mode === 'llm') {
    return { model: invocation.model, auth: invocation.auth, budgets: invocation.budgets };
  }
  if (invocation.reason === 'unavailable') {
    throw new AgentAuthUnavailableError(
      invocation.model.provider,
      'managed auth, environment, --auth-secret',
      'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.',
    );
  }
  throw new EvalUsageError(
    'The agentic tier runs a real model, but the environment selects the no-LLM path ' +
      '(for example LLM_PROVIDER=none). Unset it to run pnpm eval:tasks.',
  );
}

async function defaultResolveInvocation(options: AgentModelOptions): Promise<AgentInvocation> {
  return resolveAgentInvocation('eval', options, process.env, await loadEffectivePreferences());
}

function runScore(run: ScenarioRun, scenario: Scenario): RunScore {
  const scores = scoreRun(run, scenario, scenario.truth());
  // Parsed, not cast: each run's scores are validated as they are recorded.
  return RunScoreSchema.parse({
    run_id: run.outcome.runId,
    outcome_kind: run.outcome.kind,
    ...scores,
  });
}

/** Summarize measured runs, including a checkpoint's incomplete sample. */
export function aggregate(runs: readonly RunScore[]): ScenarioScore['aggregate'] {
  const of = (pick: (run: RunScore) => number | null): number | null => median(runs.map(pick));
  const actions = runs.flatMap((run) => (run.action === undefined ? [] : [run.action]));
  const p95 = (values: readonly (number | null)[]): number | null => {
    const sorted = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
  };
  return {
    ...(actions.length === 0
      ? {}
      : {
          task_success_rate:
            actions.filter((action) => action.task_success).length / actions.length,
          reported_success_rate:
            actions.filter((action) => action.reported_success).length / actions.length,
          false_fulfilled: actions.filter(
            (action) => action.reported_success && !action.task_success,
          ).length,
          field_correctness: of((run) => run.action?.field_correctness.value ?? null),
          wall_ms_p95: p95(runs.map((run) => run.cost.wall_ms)),
          tool_ms: of((run) => run.timing?.tool_ms ?? null),
          tool_ms_p95: p95(runs.map((run) => run.timing?.tool_ms ?? null)),
          reasoning_tokens: of((run) => run.timing?.reasoning_tokens ?? null),
          reasoning_tokens_p95: p95(runs.map((run) => run.timing?.reasoning_tokens ?? null)),
          retries: of((run) => run.timing?.retries ?? null),
          captures: of((run) => run.timing?.captures ?? null),
        }),
    field_coverage: of((run) => run.field_coverage.value),
    constraint_fidelity: of((run) => run.constraint_fidelity.value),
    source_fidelity: of((run) => run.source_fidelity.value),
    citation_validity: of((run) => run.citation_validity.value),
    honesty: of((run) => run.honesty.value),
    turns: of((run) => run.cost.turns),
    wall_ms: of((run) => run.cost.wall_ms),
    cost_usd: of((run) => run.cost.cost_usd),
    navigations: of((run) => run.cost.navigations),
    browser_launches: of((run) => run.cost.browser_launches),
    interaction_required: of((run) => run.interaction_required),
    stability: stability(runs),
  };
}

/** Total only the measured runs retained in a scorecard. */
export function totals(scenarios: readonly ScenarioScore[], wallMs: number): ScoreCard['totals'] {
  const runs = scenarios.flatMap((scenario) => scenario.runs);
  const costs = runs.map((run) => run.cost.cost_usd);
  return {
    runs: runs.length,
    wall_ms: Math.round(wallMs),
    cost_usd: costs.every((value) => value === null)
      ? null
      : Math.round(costs.reduce<number>((sum, value) => sum + (value ?? 0), 0) * 10_000) / 10_000,
    navigations: runs.reduce((sum, run) => sum + (run.cost.navigations ?? 0), 0),
    browser_launches: runs.reduce((sum, run) => sum + run.cost.browser_launches, 0),
  };
}

function timestamp(date: Date): string {
  return date
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: harnessRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    // swallow-ok: a scorecard outside a git checkout simply records no commit.
    return null;
  }
}

/**
 * The `pnpm eval:tasks` entry point.
 *
 * @param argv Arguments after the script name.
 * @returns The process exit code.
 */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseEvalArgs(argv);
    const { card } = await evaluate(options);
    if (options.json) process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
    return 0;
  } catch (error) {
    const failure = evalFailure(error);
    process.stderr.write(`${failure.line}\n`);
    return failure.exitCode;
  }
}

/**
 * The stderr line and exit code for a failed evaluation, following the CLI:
 * 1 for usage, 3 for startup or provider-availability environment failures,
 * 2 for anything else.
 */
export function evalFailure(error: unknown): {
  readonly line: string;
  readonly exitCode: 1 | 2 | 3;
} {
  if (error instanceof EvalUsageError) return { line: `eval:tasks: ${error.message}`, exitCode: 1 };
  if (error instanceof EvalProviderUnavailableError)
    return { line: `AGENT_PROVIDER_UNAVAILABLE: ${error.message}`, exitCode: 3 };
  if (error instanceof AgentStartupError)
    return { line: `${error.code}: ${error.message}`, exitCode: 3 };
  return {
    line: `eval:tasks failed: ${error instanceof Error ? error.message : String(error)}`,
    exitCode: 2,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
