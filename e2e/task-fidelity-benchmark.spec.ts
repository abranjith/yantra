/** @no-llm Benchmark targets, compatibility and command boundaries. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildBenchmark, main, renderBenchmark, percentile } from './task-fidelity/benchmark.js';
import { BaselineSchema, type Baseline } from './task-fidelity/score/scorecard-schema.js';

const baselinePath = fileURLToPath(
  new URL('./task-fidelity/baselines/2026-10-baseline.json', import.meta.url),
);
async function card(model = 'one', runs = 20, successes = 19): Promise<Baseline> {
  const original = BaselineSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));
  const template = original.scenarios[0]!;
  const source = template.runs[0]!;
  const yes = { value: 1, numerator: 1, denominator: 1, detail: [] };
  return {
    ...original,
    model: { provider: 'test', id: model, thinking: 'high' },
    benchmark_phase: 'after',
    scenarios: ['table', 'css', 'sections'].map((layout) => ({
      ...template,
      id: `bench-form-${layout}`,
      runs: Array.from({ length: runs }, (_, index) => ({
        ...source,
        run_id: `${model}-${layout}-${index}`,
        cost: { ...source.cost, wall_ms: 100000 },
        action: {
          field_correctness: yes,
          exempt_untouched: yes,
          submissions: 0,
          capture: yes,
          item_agreement: yes,
          outcome_agreement: true,
          task_success: index < successes,
          reported_success: true,
        },
        timing: { tool_ms: 50000, reasoning_tokens: null, retries: 0, captures: 1 },
      })),
    })),
  };
}
describe('@no-llm benchmark report', () => {
  it('uses the median for p50 and nearest-rank p95 without inventing missing timing', () => {
    expect(percentile([10, 20, null], 0.5)).toBe(15);
    expect(percentile([10, 20, null], 0.95)).toBe(20);
    expect(percentile([null], 0.5)).toBeNull();
  });
  it('meets every target with two settings on three layouts at 19/20', async () => {
    const report = buildBenchmark([
      { file: 'one', card: await card() },
      { file: 'two', card: await card('two') },
    ]);
    expect(report.targets.every((target) => target.met)).toBe(true);
    expect(report.cells).toHaveLength(6);
    expect(report.cells[0]).toMatchObject({
      runs: 20,
      successes: 19,
      reported: 20,
      false_fulfilled: 1,
      tool_ms_p50: 50000,
      reasoning_tokens_p50: null,
    });
    expect(renderBenchmark(report)).toContain('not recorded');
  });
  it('names underperforming and insufficient cells, and fails slow p95', async () => {
    const slow = await card('slow', 20, 18);
    slow.scenarios[0]!.runs.forEach((run) => {
      run.cost.wall_ms = 401000;
    });
    const report = buildBenchmark([
      { file: 'slow', card: slow },
      { file: 'short', card: await card('short', 5, 5) },
    ]);
    expect(report.targets.find((target) => target.id === 'per-cell-success')).toMatchObject({
      met: false,
    });
    expect(report.targets[0]!.detail).toContain('18/20');
    expect(report.targets[0]!.detail).toContain('insufficient runs');
    expect(report.targets.find((target) => target.id === 'p95')?.met).toBe(false);
  });
  it('requires the settings to pass the same layouts', async () => {
    const one = await card();
    const two = await card('two');
    two.scenarios.forEach((scenario) => {
      scenario.id += '-other';
    });
    expect(
      buildBenchmark([
        { file: 'one', card: one },
        { file: 'two', card: two },
      ]).targets.find((target) => target.id === 'models')?.met,
    ).toBe(false);
  });
  it('rejects inconsistent prompts within one phase, and displays before/after deltas', async () => {
    const before = await card();
    before.benchmark_phase = 'before';
    before.prompt_version = 'agent-v10';
    const after = await card();
    after.prompt_version = 'agent-v15';
    expect(
      renderBenchmark(
        buildBenchmark([
          { file: 'before', card: before },
          { file: 'after', card: after },
        ]),
      ),
    ).toContain('Delta success');
    before.benchmark_phase = 'after';
    expect(() =>
      buildBenchmark([
        { file: 'before.json', card: before },
        { file: 'after.json', card: after },
      ]),
    ).toThrow(/before.json.*after.json/u);
  });
  it('returns usage and validation errors, writes observational reports, and imports under tsx', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'yantra-benchmark-'));
    try {
      const file = join(directory, 'baseline.json');
      await writeFile(file, JSON.stringify(await card('small', 5, 5)));
      expect(await main([file, '--out', directory])).toBe(0);
      expect(JSON.parse(await readFile(join(directory, 'benchmark.json'), 'utf8'))).toHaveProperty(
        'targets',
      );
      expect(await main([])).toBe(1);
      await writeFile(file, '{}');
      expect(await main([file])).toBe(1);
      expect(await main([join(directory, 'missing.json')])).toBe(2);
      const modulePath = fileURLToPath(new URL('./task-fidelity/benchmark.ts', import.meta.url));
      const output = execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(pathToFileURL(modulePath).href)}); console.log('imported');`,
        ],
        { encoding: 'utf8' },
      );
      expect(output.trim()).toBe('imported');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
