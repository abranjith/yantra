/**
 * `scorecard.md`: the human-readable view of a scorecard (FEAT-049 TASK-009).
 *
 * Deterministic: the same scorecard always renders the same bytes, so the
 * self-test pins it against a golden.
 */

import type { ScoreCard } from './scorecard-schema.js';

const DIMENSIONS = [
  ['field_coverage', 'Coverage'],
  ['constraint_fidelity', 'Constraints'],
  ['source_fidelity', 'Sources'],
  ['citation_validity', 'Citations'],
  ['honesty', 'Honesty'],
] as const;

/** A score, or `—` for "not measured". */
function cell(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

/** A cost figure, or `—`. */
function amount(value: number | null, digits = 0): string {
  return value === null ? '—' : value.toFixed(digits);
}

/**
 * Render a scorecard as Markdown: one table of median scores per scenario,
 * one cost table, and a per-run detail section listing each score's reasons.
 */
export function renderScorecardMarkdown(card: ScoreCard): string {
  const lines: string[] = [
    '# Task-fidelity scorecard',
    '',
    `- Model: \`${card.model.provider}/${card.model.id}\`${card.model.thinking === null ? '' : ` (thinking: ${card.model.thinking})`}`,
    `- Prompt: \`${card.prompt_version}\``,
    `- Runs per scenario: ${card.runs_per_scenario}`,
    `- Generated: ${card.generated_at}${card.git_sha === null ? '' : ` at \`${card.git_sha}\``}`,
    '',
    'Scores are medians across runs; `—` means not measured (a zero denominator). ' +
      'Scores are observational and never gate CI.',
    '',
    '## Scores',
    '',
    `| Scenario | ${DIMENSIONS.map(([, label]) => label).join(' | ')} | Stability (Jaccard) | Same top-5 |`,
    `| --- | ${DIMENSIONS.map(() => '---:').join(' | ')} | ---: | ---: |`,
  ];
  for (const scenario of card.scenarios) {
    const { aggregate } = scenario;
    lines.push(
      `| ${scenario.id} | ${DIMENSIONS.map(([key]) => cell(aggregate[key])).join(' | ')} | ` +
        `${cell(aggregate.stability.mean_jaccard_top5)} | ` +
        `${aggregate.stability.same_top5_in_at_least}/${scenario.runs.length} |`,
    );
  }
  lines.push(
    '',
    '## Cost (medians)',
    '',
    '| Scenario | Turns | Wall (s) | Cost (USD) | Navigations | Browser launches | Interaction required |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const scenario of card.scenarios) {
    const { aggregate } = scenario;
    lines.push(
      `| ${scenario.id} | ${amount(aggregate.turns)} | ` +
        `${aggregate.wall_ms === null ? '—' : (aggregate.wall_ms / 1000).toFixed(1)} | ` +
        `${amount(aggregate.cost_usd, 4)} | ${amount(aggregate.navigations)} | ` +
        `${amount(aggregate.browser_launches)} | ${amount(aggregate.interaction_required)} |`,
    );
  }
  lines.push(
    '',
    `Totals: ${card.totals.runs} runs, ${(card.totals.wall_ms / 1000).toFixed(1)} s, ` +
      `${card.totals.cost_usd === null ? 'cost not reported' : `$${card.totals.cost_usd.toFixed(4)}`}, ` +
      `${card.totals.navigations} navigations, ${card.totals.browser_launches} browser launches.`,
    '',
    '## Per-run detail',
  );
  for (const scenario of card.scenarios) {
    scenario.runs.forEach((run, index) => {
      lines.push(
        '',
        `### ${scenario.id} — run ${index + 1} (\`${run.run_id}\`, ${run.outcome_kind})`,
        '',
      );
      for (const [key, label] of DIMENSIONS) {
        const score = run[key];
        lines.push(`- **${label}** ${cell(score.value)} (${score.numerator}/${score.denominator})`);
        for (const reason of score.detail) lines.push(`  - ${reason}`);
      }
      lines.push(
        `- **Delivered rows** ${run.delivered_row_keys.length === 0 ? 'none' : run.delivered_row_keys.join(', ')}`,
      );
    });
  }
  return `${lines.join('\n')}\n`;
}
