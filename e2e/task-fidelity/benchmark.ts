/** Dev-only benchmark aggregation. Importable from tsx without Vitest or browser startup. */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { BaselineSchema, type Baseline } from './score/scorecard-schema.js';

export interface BenchmarkInput {
  file: string;
  card: Baseline;
}
export interface BenchmarkCell {
  scenario: string;
  model: string;
  phase: string;
  runs: number;
  successes: number;
  reported: number;
  false_fulfilled: number;
  p50_ms: number | null;
  p95_ms: number | null;
  tool_ms_p50: number | null;
  tool_ms_p95: number | null;
  reasoning_tokens_p50: number | null;
  reasoning_tokens_p95: number | null;
  field_correctness: number | null;
  retries: number | null;
  captures: number | null;
  delta: { success_rate: number; p50_ms: number | null; p95_ms: number | null } | null;
}
export interface BenchmarkReport {
  schema_version: 1;
  generated_at: string;
  git_sha: string | null;
  inputs: {
    file: string;
    model: string;
    prompt_version: string;
    phase: string;
    git_sha: string | null;
  }[];
  cells: BenchmarkCell[];
  targets: { id: string; met: boolean; detail: string }[];
}
export class BenchmarkUsageError extends Error {}

/** Nearest-rank percentiles; absent telemetry stays absent rather than becoming zero. */
export function percentile(
  values: readonly (number | null | undefined)[],
  fraction: number,
): number | null {
  const sorted = values.filter((value): value is number => value != null).sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
function setting(card: Baseline): string {
  return `${card.model.provider}/${card.model.id}/${card.model.thinking ?? 'default'}`;
}
function phase(card: Baseline): string {
  return card.benchmark_phase ?? 'after';
}

/** Prompt versions must agree within a model and phase; before and after intentionally differ. */
export function buildBenchmark(
  inputs: readonly BenchmarkInput[],
  now = new Date(),
): BenchmarkReport {
  const prompts = new Map<string, BenchmarkInput>();
  const groups = new Map<
    string,
    { scenario: string; model: string; phase: string; runs: Baseline['scenarios'][number]['runs'] }
  >();
  for (const input of inputs) {
    const key = JSON.stringify([setting(input.card), phase(input.card)]);
    const prior = prompts.get(key);
    if (prior !== undefined && prior.card.prompt_version !== input.card.prompt_version)
      throw new BenchmarkUsageError(
        `prompt_version mismatch: ${prior.file} (${prior.card.prompt_version}) and ${input.file} (${input.card.prompt_version})`,
      );
    prompts.set(key, input);
    for (const scenario of input.card.scenarios.filter((entry) =>
      entry.id.startsWith('bench-form-'),
    )) {
      const cellKey = JSON.stringify([scenario.id, key]);
      let group = groups.get(cellKey);
      if (group === undefined) {
        group = {
          scenario: scenario.id,
          model: setting(input.card),
          phase: phase(input.card),
          runs: [],
        };
        groups.set(cellKey, group);
      }
      for (const run of scenario.runs) {
        if (group.runs.some((existing) => existing.run_id === run.run_id))
          throw new BenchmarkUsageError(`duplicate run ${run.run_id} in ${input.file}`);
        group.runs.push(run);
      }
    }
  }
  if (groups.size === 0) throw new BenchmarkUsageError('inputs contain no bench-form-* runs');
  const cells: BenchmarkCell[] = [...groups.values()]
    .map((group) => ({
      scenario: group.scenario,
      model: group.model,
      phase: group.phase,
      runs: group.runs.length,
      successes: group.runs.filter((run) => run.action?.task_success === true).length,
      reported: group.runs.filter((run) => run.action?.reported_success === true).length,
      false_fulfilled: group.runs.filter(
        (run) => run.action?.reported_success === true && !run.action.task_success,
      ).length,
      p50_ms: percentile(
        group.runs.map((run) => run.cost.wall_ms),
        0.5,
      ),
      p95_ms: percentile(
        group.runs.map((run) => run.cost.wall_ms),
        0.95,
      ),
      tool_ms_p50: percentile(
        group.runs.map((run) => run.timing?.tool_ms),
        0.5,
      ),
      tool_ms_p95: percentile(
        group.runs.map((run) => run.timing?.tool_ms),
        0.95,
      ),
      reasoning_tokens_p50: percentile(
        group.runs.map((run) => run.timing?.reasoning_tokens),
        0.5,
      ),
      reasoning_tokens_p95: percentile(
        group.runs.map((run) => run.timing?.reasoning_tokens),
        0.95,
      ),
      field_correctness: percentile(
        group.runs.map((run) => run.action?.field_correctness.value),
        0.5,
      ),
      retries: percentile(
        group.runs.map((run) => run.timing?.retries),
        0.5,
      ),
      captures: percentile(
        group.runs.map((run) => run.timing?.captures),
        0.5,
      ),
      delta: null,
    }))
    .sort(
      (a, b) =>
        a.model.localeCompare(b.model) ||
        a.scenario.localeCompare(b.scenario) ||
        a.phase.localeCompare(b.phase),
    );
  for (const cell of cells.filter((entry) => entry.phase === 'after')) {
    const before = cells.find(
      (entry) =>
        entry.phase === 'before' && entry.model === cell.model && entry.scenario === cell.scenario,
    );
    if (before !== undefined)
      cell.delta = {
        success_rate: cell.successes / cell.runs - before.successes / before.runs,
        p50_ms: cell.p50_ms === null || before.p50_ms === null ? null : cell.p50_ms - before.p50_ms,
        p95_ms: cell.p95_ms === null || before.p95_ms === null ? null : cell.p95_ms - before.p95_ms,
      };
  }
  const observed = cells.filter((entry) => entry.phase === 'after');
  const passes = (cell: BenchmarkCell): boolean =>
    cell.runs >= 20 && cell.successes / cell.runs >= 0.95;
  const failed = observed.filter((cell) => !passes(cell));
  const layouts = [...new Set(observed.filter(passes).map((cell) => cell.scenario))];
  const models = [...new Set(observed.map((cell) => cell.model))];
  // At least two settings must meet the target on the same three layouts.
  const qualifyingPairs = models.flatMap((a, index) =>
    models
      .slice(index + 1)
      .map(
        (b) =>
          layouts.filter((layout) =>
            [a, b].every((model) =>
              observed.some(
                (cell) => cell.model === model && cell.scenario === layout && passes(cell),
              ),
            ),
          ).length,
      ),
  );
  const latency = (property: 'p50_ms' | 'p95_ms', limit: number): boolean =>
    observed.length > 0 &&
    observed.every((cell) => cell[property] !== null && cell[property] <= limit);
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    git_sha: currentSha(),
    inputs: inputs.map(({ file, card }) => ({
      file,
      model: setting(card),
      prompt_version: card.prompt_version,
      phase: phase(card),
      git_sha: card.git_sha,
    })),
    cells,
    targets: [
      {
        id: 'per-cell-success',
        met: observed.length > 0 && failed.length === 0,
        detail:
          failed.length === 0
            ? `${observed.length} cells meet 95% with at least 20 runs`
            : failed
                .map(
                  (cell) =>
                    `${cell.model} ${cell.scenario}: ${cell.successes}/${cell.runs}${cell.runs < 20 ? ' (insufficient runs)' : ''}`,
                )
                .join('; '),
      },
      { id: 'layouts', met: layouts.length >= 3, detail: `${layouts.length} layouts meet 95%` },
      {
        id: 'models',
        met: qualifyingPairs.some((count) => count >= 3),
        detail: 'Requires two settings meeting 95% on the same three layouts',
      },
      {
        id: 'p50',
        met: latency('p50_ms', 120000),
        detail: 'Every after cell: p50 <= 120000 ms; missing timing is unmet',
      },
      {
        id: 'p95',
        met: latency('p95_ms', 300000),
        detail: 'Every after cell: p95 <= 300000 ms; missing timing is unmet',
      },
    ],
  };
}
function currentSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  } // swallow-ok: reports outside git have no current commit.
}
function shown(value: number | null): string {
  return value === null ? 'not recorded' : String(Math.round(value * 1000) / 1000);
}
function escaped(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/[\r\n]/g, ' ');
}
export function renderBenchmark(report: BenchmarkReport): string {
  const lines = [
    '# Form benchmark',
    '',
    'Targets are observational. True success uses independent fixture state; reported success is the run outcome.',
    '',
  ];
  for (const model of new Set(report.cells.map((cell) => cell.model))) {
    lines.push(
      `## ${escaped(model)}`,
      '',
      '| Layout / phase | True | Reported | False fulfilled | Wall p50 / p95 ms | Tool p50 / p95 ms | Reasoning p50 / p95 | Correctness | Retries | Captures | Delta success / p50 / p95 ms |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const cell of report.cells.filter((entry) => entry.model === model))
      lines.push(
        `| ${escaped(cell.scenario)} / ${cell.phase} | ${cell.successes}/${cell.runs} | ${cell.reported} | ${cell.false_fulfilled} | ${shown(cell.p50_ms)} / ${shown(cell.p95_ms)} | ${shown(cell.tool_ms_p50)} / ${shown(cell.tool_ms_p95)} | ${shown(cell.reasoning_tokens_p50)} / ${shown(cell.reasoning_tokens_p95)} | ${shown(cell.field_correctness)} | ${shown(cell.retries)} | ${shown(cell.captures)} | ${cell.delta === null ? '-' : `${shown(cell.delta.success_rate)} / ${shown(cell.delta.p50_ms)} / ${shown(cell.delta.p95_ms)}`} |`,
      );
    lines.push('');
  }
  lines.push('## Targets', '', '| Target | Met | Detail |', '| --- | --- | --- |');
  for (const target of report.targets)
    lines.push(`| ${target.id} | ${target.met ? 'yes' : 'no'} | ${escaped(target.detail)} |`);
  lines.push('', '## Inputs', '');
  for (const input of report.inputs)
    lines.push(
      `- ${escaped(input.file)}: ${input.phase}, ${escaped(input.model)}, ${input.prompt_version}, commit ${input.git_sha ?? 'not recorded'}`,
    );
  return `${lines.join('\n')}\n`;
}
export async function main(argv: readonly string[]): Promise<number> {
  try {
    let args;
    try {
      args = parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: { out: { type: 'string' }, json: { type: 'boolean' } },
      });
    } catch (error) {
      throw new BenchmarkUsageError(String(error));
    }
    if (args.positionals.length === 0)
      throw new BenchmarkUsageError(
        'usage: eval:benchmark <scorecard.json>... [--out <dir>] [--json]',
      );
    const inputs: BenchmarkInput[] = [];
    for (const file of args.positionals) {
      const source = await readFile(file, 'utf8');
      try {
        inputs.push({ file, card: BaselineSchema.parse(JSON.parse(source)) });
      } catch (error) {
        throw new BenchmarkUsageError(`${file}: invalid scorecard: ${String(error)}`);
      }
    }
    const report = buildBenchmark(inputs);
    const out = resolve(args.values.out ?? 'e2e/task-fidelity/.out/benchmark');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(out, 'benchmark.md'), renderBenchmark(report));
    if (args.values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stderr.write(`benchmark written to ${out}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `eval:benchmark: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return error instanceof BenchmarkUsageError ? 1 : 2;
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
