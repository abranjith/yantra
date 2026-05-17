/**
 * `yantra show <workflow-or-run>` — displays a saved workflow or run.
 *
 * Auto-detects the kind from the argument (ISO-prefixed → run, else
 * workflow); `--workflow` / `--run` overrides force the choice. Read-only:
 * never takes the run-dir lock.
 *
 * @example
 *   yantra show bank-statement
 *   yantra show 20260516T120304Z-bank-statement-a7b3
 *   yantra show bank-statement --json
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FileWorkflowStore, workflowsRoot } from '@yantra/core';
import { LocalRunStore } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ShowItem } from '../render/types.js';

import { detectShowTarget } from './auto-detect.js';

interface ShowOptions {
  readonly workflow?: boolean;
  readonly run?: boolean;
  readonly json?: boolean;
  readonly events?: string;
}

export function makeShowCommand(): Command {
  const cmd = new Command('show');

  cmd
    .description('Display a saved workflow or run')
    .argument('<target>', 'Workflow name OR run-id')
    .option('--workflow', 'force workflow lookup')
    .option('--run', 'force run lookup')
    .option('--events <n>', 'number of recent events to display for a run', '20')
    .option('--json', 'emit JSON instead of human-readable output', false)
    .action(async (target: string, options: ShowOptions) => {
      const flags = readGlobalFlags({
        argv: process.argv,
        env: process.env,
        isTty: process.stdout.isTTY ?? false,
      });
      const renderer =
        options.json === true || flags.json ? new JSONRenderer() : new TerminalRenderer();
      const connector = new CLIConnectorIO(renderer);
      const renderOpts = buildRenderOpts({
        ...flags,
        json: options.json === true || flags.json,
      });

      try {
        const kind =
          options.workflow === true
            ? 'workflow'
            : options.run === true
              ? 'run'
              : detectShowTarget(target);

        if (kind === 'workflow') {
          const store = new FileWorkflowStore(workflowsRoot());
          const loadResult = await store.load(target);
          if (!loadResult.isOk) {
            process.stderr.write(`Workflow "${target}" could not be loaded.\n`);
            process.exit(1);
          }
          const workflow = loadResult.value;
          const yaml = JSON.stringify(workflow, null, 2);
          const locatorCounts: Record<string, number> = {};
          const locatorTable = (workflow as { _locators?: Record<string, unknown[]> })._locators;
          if (locatorTable !== undefined) {
            for (const [name, chain] of Object.entries(locatorTable)) {
              locatorCounts[name] = Array.isArray(chain) ? chain.length : 0;
            }
          }
          const item: ShowItem = { kind: 'workflow', name: workflow.name, yaml, locatorCounts };
          connector.renderResult({ kind: 'show', item }, renderOpts);
          process.exit(0);
        }

        const runStore = new LocalRunStore();
        const run = await runStore.getRun(target);
        if (run === null) {
          process.stderr.write(`Run "${target}" not found.\n`);
          process.exit(1);
        }
        const events = await readRecentEvents(run.runDir, parseEventCount(options.events));
        const item: ShowItem = {
          kind: 'run',
          runId: target,
          manifest: run.manifest as unknown as Readonly<Record<string, unknown>>,
          events,
        };
        connector.renderResult({ kind: 'show', item }, renderOpts);
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}

function parseEventCount(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 1000);
}

async function readRecentEvents(
  runDir: string,
  count: number,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  try {
    const text = await readFile(join(runDir, 'events.jsonl'), 'utf8');
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-count);
    const events: Readonly<Record<string, unknown>>[] = [];
    for (const line of tail) {
      try {
        events.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // Corrupt line — skip rather than abort the entire show.
      }
    }
    return events;
  } catch {
    return [];
  }
}
