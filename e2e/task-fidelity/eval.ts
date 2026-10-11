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
 * Exit codes follow the CLI: 0 written, 1 usage, 2 execution, 3 environment
 * (missing model credentials, checked before any fixture server starts).
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
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
        runs: { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new EvalUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values } = parsed;
  const runs = values.runs === undefined ? 3 : Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new EvalUsageError('--runs must be a positive integer.');
  }
  return {
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
 * Run the agentic tier and write its scorecard.
 *
 * @throws {EvalUsageError} for an unknown scenario or a no-LLM environment.
 * @throws {AgentAuthUnavailableError} when no model credential is available —
 *   before any fixture server starts.
 */
export async function evaluate(
  options: EvalOptions,
  deps: EvalDependencies = {},
): Promise<EvalResult> {
  const stderr = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = deps.now ?? (() => new Date());
  const scenarios = selectScenarios(options.scenarios);
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
  let totalWallMs = 0;
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
      totalWallMs += result.wallMs;
      const score = runScore(result, scenario);
      runs.push(score);
      stderr(
        `${scenario.id} ${index}/${options.runs} · ${result.outcome.kind} · ` +
          `${score.cost.turns ?? '?'} turns · ${Math.round(result.wallMs / 1000)} s`,
      );
    }
    scored.push({ id: scenario.id, runs, aggregate: aggregate(runs) });
  }

  const card = ScoreCardSchema.parse({
    schema_version: 1,
    generated_at: now().toISOString(),
    git_sha: gitSha(),
    prompt_version: PROMPT_VERSION,
    model: {
      provider: selection.model.provider,
      id: selection.model.id,
      thinking: selection.model.thinking ?? null,
    },
    runs_per_scenario: options.runs,
    scenarios: scored,
    totals: totals(scored, totalWallMs),
  } satisfies ScoreCard);
  const markdown = renderScorecardMarkdown(card);
  await writeFile(join(outDir, 'scorecard.json'), `${JSON.stringify(card, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'scorecard.md'), markdown, 'utf8');
  // The committable projection: copy it to `baselines/` to record a baseline.
  const baseline = BaselineSchema.parse(baselineOf(card));
  await writeFile(join(outDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  stderr(`scorecard written to ${outDir}`);
  return { card, outDir, markdown };
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

function aggregate(runs: readonly RunScore[]): ScenarioScore['aggregate'] {
  const of = (pick: (run: RunScore) => number | null): number | null => median(runs.map(pick));
  return {
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

function totals(scenarios: readonly ScenarioScore[], wallMs: number): ScoreCard['totals'] {
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
 * 1 for usage, 3 for a typed startup (environment) failure such as missing
 * model credentials, 2 for anything else.
 */
export function evalFailure(error: unknown): {
  readonly line: string;
  readonly exitCode: 1 | 2 | 3;
} {
  if (error instanceof EvalUsageError) return { line: `eval:tasks: ${error.message}`, exitCode: 1 };
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
