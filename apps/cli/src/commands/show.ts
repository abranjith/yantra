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
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { buildRenderOpts } from '../connector-io.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { commandFlags } from '../context/flags.js';
import type { HandlerArgs } from '../registry/handler.js';
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

/** `yantra show`: bound to the `show` registry entry. */
export async function showHandler(
  args: HandlerArgs,
  options: ShowOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const [target] = args as readonly [string];
  const flags = commandFlags(context, options);
  const renderer =
    options.json === true || flags.json ? new JSONRenderer() : new TerminalRenderer();
  const connector = context.connector(renderer);
  const renderOpts = buildRenderOpts(
    {
      ...flags,
      json: options.json === true || flags.json,
    },
    context.output,
  );

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
        context.output.stderr.write(`Workflow "${target}" could not be loaded.\n`);
        throw new CommandFailure(1, 'yantra.show.failed', '', null, true);
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
      return;
    }

    const runStore = new LocalRunStore();
    const run = await runStore.getRun(target);
    if (run === null) {
      context.output.stderr.write(`Run "${target}" not found.\n`);
      throw new CommandFailure(1, 'yantra.show.failed', '', null, true);
    }
    const events = await readRecentEvents(run.runDir, parseEventCount(options.events));
    const item: ShowItem = {
      kind: 'run',
      runId: target,
      manifest: run.manifest as unknown as Readonly<Record<string, unknown>>,
      events,
    };
    connector.renderResult({ kind: 'show', item }, renderOpts);
    return;
  } catch (err) {
    if (err instanceof CommandFailure) throw err;

    const message = err instanceof Error ? err.message : String(err);
    context.output.stderr.write(`Error: ${message}\n`);
    throw new CommandFailure(1, 'yantra.show.failed', '', null, true);
  }
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
