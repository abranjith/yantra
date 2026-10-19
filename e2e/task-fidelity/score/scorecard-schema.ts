/**
 * `scorecard.json` (FEAT-049 TASK-009): the agentic tier's dev-only artifact.
 *
 * Deliberately not in `@yantra/protocol`: the scorecard is harness output, not
 * a run-artifact format users own. It is versioned (`schema_version: 1`) so a
 * committed baseline stays readable as the harness grows.
 */

import { z } from 'zod';

/** One scored dimension: `value` is null exactly when `denominator` is 0. */
export const ScoreSchema = z
  .object({
    value: z.number().min(0).max(1).nullable(),
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    detail: z.array(z.string()),
  })
  .refine((score) => (score.denominator === 0) === (score.value === null), {
    message: 'value must be null exactly when the denominator is 0',
  });

export const CostSchema = z.object({
  turns: z.number().int().nonnegative().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  wall_ms: z.number().nonnegative().nullable(),
  navigations: z.number().int().nonnegative().nullable(),
  browser_launches: z.number().int().nonnegative(),
  fixture_requests: z.number().int().nonnegative(),
});

export const ActionScoreSchema = z.object({
  field_correctness: ScoreSchema,
  exempt_untouched: ScoreSchema,
  submissions: z.number().int().nonnegative(),
  capture: ScoreSchema,
  item_agreement: ScoreSchema,
  outcome_agreement: z.boolean().nullable(),
  reported_success: z.boolean(),
  task_success: z.boolean(),
});
export const TimingScoreSchema = z.object({
  tool_ms: z.number().int().nonnegative(),
  reasoning_tokens: z.number().int().nonnegative().nullable(),
  retries: z.number().int().nonnegative(),
  captures: z.number().int().nonnegative(),
});

export const RunScoreSchema = z.object({
  action: ActionScoreSchema.optional(),
  timing: TimingScoreSchema.optional(),
  run_id: z.string().min(1),
  outcome_kind: z.string().min(1),
  field_coverage: ScoreSchema,
  constraint_fidelity: ScoreSchema,
  source_fidelity: ScoreSchema,
  citation_validity: ScoreSchema,
  honesty: ScoreSchema,
  cost: CostSchema,
  interaction_required: z.number().int().nonnegative(),
  delivered_row_keys: z.array(z.string()),
});

const Median = z.number().min(0).max(1).nullable();

export const AggregateSchema = z.object({
  task_success_rate: z.number().min(0).max(1).optional(),
  reported_success_rate: z.number().min(0).max(1).optional(),
  false_fulfilled: z.number().int().nonnegative().optional(),
  field_correctness: Median.optional(),
  wall_ms_p95: z.number().nonnegative().nullable().optional(),
  tool_ms: z.number().nonnegative().nullable().optional(),
  tool_ms_p95: z.number().nonnegative().nullable().optional(),
  reasoning_tokens: z.number().nonnegative().nullable().optional(),
  reasoning_tokens_p95: z.number().nonnegative().nullable().optional(),
  retries: z.number().nonnegative().nullable().optional(),
  captures: z.number().nonnegative().nullable().optional(),
  field_coverage: Median,
  constraint_fidelity: Median,
  source_fidelity: Median,
  citation_validity: Median,
  honesty: Median,
  turns: z.number().nonnegative().nullable(),
  wall_ms: z.number().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  navigations: z.number().nonnegative().nullable(),
  browser_launches: z.number().nonnegative().nullable(),
  interaction_required: z.number().nonnegative().nullable(),
  stability: z.object({
    mean_jaccard_top5: z.number().min(0).max(1).nullable(),
    same_top5_in_at_least: z.number().int().nonnegative(),
  }),
});

export const ScenarioScoreSchema = z.object({
  id: z.string().min(1),
  runs: z.array(RunScoreSchema),
  aggregate: AggregateSchema,
});

export const ScoreCardSchema = z.object({
  schema_version: z.literal(1),
  benchmark_phase: z.enum(['before', 'after']).optional(),
  generated_at: z.string().datetime(),
  git_sha: z.string().nullable(),
  prompt_version: z.string().min(1),
  model: z.object({
    provider: z.string().min(1),
    id: z.string().min(1),
    thinking: z.string().nullable(),
  }),
  runs_per_scenario: z.number().int().min(1),
  scenarios: z.array(ScenarioScoreSchema),
  totals: z.object({
    runs: z.number().int().nonnegative(),
    wall_ms: z.number().nonnegative(),
    cost_usd: z.number().nonnegative().nullable(),
    navigations: z.number().int().nonnegative(),
    browser_launches: z.number().int().nonnegative(),
  }),
});

export type ScoreCard = z.infer<typeof ScoreCardSchema>;
export type ScenarioScore = z.infer<typeof ScenarioScoreSchema>;
export type RunScore = z.infer<typeof RunScoreSchema>;

/**
 * The committed baseline: the scorecard's aggregate-only projection. Per-run
 * delivered row keys are dropped, and no run directory or page text is kept.
 */
export const BaselineSchema = ScoreCardSchema.extend({
  scenarios: z.array(
    ScenarioScoreSchema.extend({
      runs: z.array(RunScoreSchema.omit({ delivered_row_keys: true })),
    }),
  ),
});

export type Baseline = z.infer<typeof BaselineSchema>;

/** Project a scorecard onto its committable, aggregate-only baseline. */
export function baselineOf(card: ScoreCard): Baseline {
  return {
    ...card,
    scenarios: card.scenarios.map((scenario) => ({
      ...scenario,
      runs: scenario.runs.map(({ delivered_row_keys: _dropped, ...run }) => run),
    })),
  };
}
