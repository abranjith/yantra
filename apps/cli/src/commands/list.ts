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

import { FileWorkflowStore, workflowsRoot, type Logger } from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
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

        const runStore = new LocalRunStore();
        const runs = await runStore.listRuns({
          ...(options.workflow !== undefined ? { workflowName: options.workflow } : {}),
          ...(options.status !== undefined ? { status: options.status as never } : {}),
          limit,
        });

        const items: ListItem[] = runs.map((r) => ({
          kind: 'run',
          runId: r.runId,
          workflowName: r.workflowName,
          status: r.status,
          startedAt: r.startedAt,
          durationMs: r.durationMs ?? null,
        }));
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

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}
