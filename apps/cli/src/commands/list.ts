/**
 * `yantra list [workflows|runs]` — enumerates saved workflows or recent runs.
 *
 * Default target is `runs` (matches the `git log` mental model — most users
 * want to see their recent activity first).
 *
 * @example
 *   yantra list
 *   yantra list workflows
 *   yantra list runs --limit 5
 *   yantra list runs --workflow bank-statement --status failed
 */

import { FileWorkflowStore, workflowsRoot, type HistoryEntry, type Logger } from '@yantra/core';
import { LocalRunStore, type RunSummary } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import { openHistory } from '../history.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ListItem } from '../render/types.js';
import { makeStderrLogger } from '../runtime.js';

interface ListOptions {
  readonly limit?: string;
  readonly workflow?: string;
  readonly status?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
}

export function makeListCommand(): Command {
  const cmd = new Command('list');

  cmd
    .description('List saved workflows or recent runs')
    .argument('[target]', 'workflows | runs', 'runs')
    .option('--limit <n>', 'maximum number of entries to show', '20')
    .option('--workflow <name>', 'filter runs by workflow name')
    .option('--status <s>', 'filter runs by status (running|completed|failed|aborted|paused)')
    .option('--json', 'emit JSON instead of a terminal table', false)
    .option('--debug', 'verbose logging on stderr', false)
    .action(async (target: string, options: ListOptions) => {
      const flags = readGlobalFlags({
        argv: process.argv,
        env: process.env,
        isTty: process.stdout.isTTY ?? false,
      });
      const renderer =
        options.json === true || flags.json ? new JSONRenderer() : new TerminalRenderer();
      const connector = new CLIConnectorIO(renderer);
      const logger: Logger = makeStderrLogger(options.debug === true);
      const renderOpts = buildRenderOpts({
        ...flags,
        json: options.json === true || flags.json,
      });

      try {
        if (target !== 'workflows' && target !== 'runs') {
          process.stderr.write(`Unknown target "${target}" (expected: workflows | runs)\n`);
          process.exit(1);
        }

        const limit = parseLimit(options.limit);

        if (target === 'workflows') {
          const store = new FileWorkflowStore(workflowsRoot());
          const workflows = await store.list();
          const items: ListItem[] = workflows.slice(0, limit).map((w) => ({
            kind: 'workflow',
            name: w.name,
            stepCount: w.step_count,
            securityClass: w.security_class,
            modifiedAt: w.last_modified.toISOString(),
          }));
          connector.renderResult({ kind: 'list', items }, renderOpts);
          process.exit(0);
        }

        const items = await listRuns(limit, options, logger);
        connector.renderResult({ kind: 'list', items }, renderOpts);
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err: message }, 'list failed');
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

/**
 * Builds the `runs` list by merging the fast history index (which includes
 * `ask`/`research` tasks) with the file-based run store (workflow runs),
 * de-duplicated by run id. When the index is unavailable it degrades to the
 * file scan alone (with a stderr hint) — the "delete index.db, list still
 * works" fallback (TASK-002 verify).
 */
async function listRuns(limit: number, options: ListOptions, logger: Logger): Promise<ListItem[]> {
  const runStore = new LocalRunStore();
  const fileRuns = await runStore.listRuns({ limit: 500 });

  const byId = new Map<string, ListItem>();
  for (const run of fileRuns) {
    byId.set(run.runId, fileRunToItem(run));
  }

  const history = await openHistory(logger);
  if (history === null) {
    process.stderr.write(
      'note: history index unavailable — showing runs from files only ' +
        '(run `yantra doctor` to rebuild the index)\n',
    );
  } else {
    try {
      const listed = await history.store.list({ limit: 500 });
      if (listed.isOk) {
        for (const entry of listed.value) {
          byId.set(entry.runId, historyToItem(entry));
        }
      }
    } finally {
      history.close();
    }
  }

  let items = [...byId.values()];
  if (options.workflow !== undefined) {
    items = items.filter((item) => item.kind === 'run' && item.workflowName === options.workflow);
  }
  if (options.status !== undefined) {
    items = items.filter((item) => item.kind === 'run' && item.status === options.status);
  }
  items.sort((a, b) => {
    const aAt = a.kind === 'run' ? a.startedAt : '';
    const bAt = b.kind === 'run' ? b.startedAt : '';
    return bAt.localeCompare(aAt);
  });
  return items.slice(0, limit);
}

function fileRunToItem(run: RunSummary): ListItem {
  return {
    kind: 'run',
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs ?? null,
  };
}

function historyToItem(entry: HistoryEntry): ListItem {
  return {
    kind: 'run',
    runId: entry.runId,
    workflowName: entry.intentText,
    status: entry.status,
    startedAt: entry.startedAt,
    durationMs: entry.durationMs,
  };
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}
