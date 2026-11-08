/**
 * `yantra usage` — rolls up recent task cost + volume from the history index.
 *
 * Reads through the local SQLite index (`HistoryStore.usageRollup`), grouping
 * tasks by UTC day and provider. When the index is unavailable it prints an
 * actionable hint rather than failing — the index is an optional cache
 * (plan §7).
 *
 * @example
 *   yantra usage
 *   yantra usage --type ask --since 7d
 *   yantra usage --since 2026-07-01 --json
 */

import type { TaskType, UsageRollupFilter, UsageRollupRow } from '@yantra/core';
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { openHistory } from '../history.js';
import type { HandlerArgs } from '../registry/handler.js';
import { CLI_JSON_SCHEMA_VERSION } from '../render/json.js';
import { makeStderrLogger } from '../runtime.js';

interface UsageOptions {
  readonly type?: string;
  readonly since?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
}

const TASK_TYPES = new Set<TaskType>(['ask', 'research', 'run', 'do']);

/** `yantra usage`: bound to the `usage` registry entry. */
export async function usageHandler(
  _args: HandlerArgs,
  options: UsageOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const logger = makeStderrLogger(options.debug === true, context.output.stderr);

  const filter: UsageRollupFilter = {};
  if (options.type !== undefined) {
    if (!TASK_TYPES.has(options.type as TaskType)) {
      context.output.stderr.write(
        `Unknown task type "${options.type}" (expected: ask|research|run|do)\n`,
      );
      throw new CommandFailure(1, 'yantra.usage.failed', '', null, true);
    }
    (filter as { taskType?: TaskType }).taskType = options.type as TaskType;
  }
  if (options.since !== undefined) {
    const since = parseSince(options.since);
    if (since === null) {
      context.output.stderr.write(
        `Invalid --since value "${options.since}" (use YYYY-MM-DD, 7d, or 24h)\n`,
      );
      throw new CommandFailure(1, 'yantra.usage.failed', '', null, true);
    }
    (filter as { since?: string }).since = since;
  }

  const history = await openHistory(logger);
  if (history === null) {
    emitEmpty(context, options, 'history index unavailable — run `yantra doctor` to rebuild it');
    return;
  }

  try {
    const result = await history.store.usageRollup(filter);
    if (!result.isOk) {
      context.output.stderr.write(`Error: ${result.error.message}\n`);
      throw new CommandFailure(1, 'yantra.usage.failed', '', null, true);
    }
    render(context, result.value, options);
    return;
  } finally {
    history.close();
  }
}

/** Resolves a `--since` value to an ISO-8601 cutoff, or null when invalid. */
export function parseSince(raw: string, now: Date = new Date()): string | null {
  const age = /^(\d+)([dh])$/.exec(raw.trim());
  if (age !== null) {
    const amount = Number.parseInt(age[1]!, 10);
    const unitMs = age[2] === 'h' ? 3_600_000 : 86_400_000;
    return new Date(now.getTime() - amount * unitMs).toISOString();
  }
  // A plain calendar date compares lexically against full ISO started_at values.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
    return raw.trim();
  }
  return null;
}

function render(
  context: CommandContext,
  rows: readonly UsageRollupRow[],
  options: UsageOptions,
): void {
  const totals = rows.reduce(
    (acc, row) => ({
      taskCount: acc.taskCount + row.taskCount,
      totalCostUsd: acc.totalCostUsd + row.totalCostUsd,
    }),
    { taskCount: 0, totalCostUsd: 0 },
  );

  if (options.json === true) {
    context.output.json({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: 'usage',
      rows,
      totals,
    });
    return;
  }

  if (rows.length === 0) {
    context.output.stdout.write('No usage recorded yet.\n');
    return;
  }

  context.output.stdout.write('Day         Provider        Tasks    Cost (USD)\n');
  context.output.stdout.write('----------  --------------  -------  ----------\n');
  for (const row of rows) {
    context.output.stdout.write(
      `${row.day.padEnd(10)}  ${(row.provider ?? '—').padEnd(14)}  ` +
        `${String(row.taskCount).padStart(7)}  ${formatCost(row.totalCostUsd).padStart(10)}\n`,
    );
  }
  context.output.stdout.write('----------  --------------  -------  ----------\n');
  context.output.stdout.write(
    `${'Total'.padEnd(10)}  ${''.padEnd(14)}  ${String(totals.taskCount).padStart(7)}  ` +
      `${formatCost(totals.totalCostUsd).padStart(10)}\n`,
  );
}

function emitEmpty(context: CommandContext, options: UsageOptions, note: string): void {
  if (options.json === true) {
    context.output.json({
      schemaVersion: CLI_JSON_SCHEMA_VERSION,
      kind: 'usage',
      rows: [],
      totals: { taskCount: 0, totalCostUsd: 0 },
      note,
    });
    return;
  }
  context.output.stdout.write(`${note}\n`);
}

function formatCost(cost: number): string {
  return cost === 0 ? '$0.00' : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}
