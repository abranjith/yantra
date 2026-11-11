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

import { join } from 'node:path';

import {
  FileWorkflowStore,
  readExecutionState,
  reconcileAll,
  runsRoot,
  workflowsRoot,
  type HistoryEntry,
  type Logger,
} from '@yantra/core';
import { LocalRunStore, type RunSummary } from '@yantra/core/workflow/replay';
import { COMMAND_REGISTRY } from '@yantra/protocol';
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { buildRenderOpts } from '../connector-io.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { commandFlags } from '../context/flags.js';
import { openHistory } from '../history.js';
import { createRegisteredCommand } from '../registry/build-command-tree.js';
import { handler, type HandlerArgs } from '../registry/handler.js';
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

/** The `list` command generated from its registry entry, for direct composition. */
export function makeListCommand(): Command {
  return createRegisteredCommand('list', { list: handler(listHandler) }, COMMAND_REGISTRY);
}

/** `yantra list [target]`: bound to the `list` registry entry. */
export async function listHandler(
  args: HandlerArgs,
  options: ListOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const [target] = args as readonly [string];
  const flags = commandFlags(context, options);
  const renderer =
    options.json === true || flags.json ? new JSONRenderer() : new TerminalRenderer();
  const connector = context.connector(renderer);
  const logger: Logger = makeStderrLogger(options.debug === true, context.output.stderr);
  const renderOpts = buildRenderOpts(
    {
      ...flags,
      json: options.json === true || flags.json,
    },
    context.output,
  );

  try {
    if (target !== 'workflows' && target !== 'runs') {
      context.output.stderr.write(`Unknown target "${target}" (expected: workflows | runs)\n`);
      throw new CommandFailure(1, 'yantra.list.failed', '', null, true);
    }

    const { items } = await buildListJson(
      {
        target,
        limit: parseLimit(options.limit),
        ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
        ...(options.status === undefined ? {} : { status: options.status }),
      },
      { logger, note: (text) => context.output.stderr.write(text) },
    );
    connector.renderResult({ kind: 'list', items }, renderOpts);
    return;
  } catch (err) {
    if (err instanceof CommandFailure) throw err;

    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'list failed');
    context.output.stderr.write(`Error: ${message}\n`);
    throw new CommandFailure(1, 'yantra.list.failed', '', null, true);
  }
}

/** A position in `startedAt DESC, runId DESC` order; pages continue strictly after it. */
export interface ListCursorKey {
  readonly startedAt: string;
  readonly runId: string;
}

/** What to list. */
export interface ListQuery {
  readonly target: 'runs' | 'workflows';
  readonly limit: number;
  readonly workflow?: string;
  readonly status?: string;
  /** Keyset cursor (runs only). */
  readonly before?: ListCursorKey;
}

/** The items `list --json` renders, plus the key the next page starts after. */
export interface ListJson {
  readonly items: ListItem[];
  /** Null when this page is the last one. */
  readonly next: ListCursorKey | null;
}

/**
 * The one builder behind `yantra list --json` and the app's `read.list`
 * (FEAT-065 TASK-007), so the two shapes cannot drift. `note` receives the
 * index-unavailable hint the terminal prints on stderr.
 */
export async function buildListJson(
  query: ListQuery,
  deps: { readonly logger: Logger; readonly note: (text: string) => void },
): Promise<ListJson> {
  if (query.target === 'workflows') {
    const store = new FileWorkflowStore(workflowsRoot());
    const workflows = await store.list();
    const items: ListItem[] = workflows.slice(0, query.limit).map((w) => ({
      kind: 'workflow',
      name: w.name,
      stepCount: w.step_count,
      securityClass: w.security_class,
      modifiedAt: w.last_modified.toISOString(),
    }));
    return { items, next: null };
  }
  const items = await listRuns(query, deps.logger, deps.note);
  const last = items.at(-1);
  const next =
    items.length === query.limit && last?.kind === 'run'
      ? { startedAt: last.startedAt, runId: last.runId }
      : null;
  return { items, next };
}

/** `a` sorts before `b` in `startedAt DESC, runId DESC` order. */
function newerFirst(a: ListCursorKey, b: ListCursorKey): number {
  const byTime = b.startedAt.localeCompare(a.startedAt);
  return byTime !== 0 ? byTime : b.runId.localeCompare(a.runId);
}

/**
 * Builds the `runs` list by merging the fast history index (which includes
 * `ask`/`research` tasks) with the file-based run store (workflow runs),
 * de-duplicated by run id. When the index is unavailable it degrades to the
 * file scan alone (with a stderr hint) — the "delete index.db, list still
 * works" fallback (TASK-002 verify). Both sources page by the same keyset.
 */
async function listRuns(
  query: ListQuery,
  logger: Logger,
  note: (text: string) => void,
): Promise<ListItem[]> {
  const { limit, before } = query;
  const history = await openHistory(logger);
  // FEAT-064: end every run whose owner died before reading, so a killed run
  // reads `interrupted`, never `running`. Blocking; failures never fail list.
  await reconcileAll({
    trigger: 'list',
    includeRunningManifests: true,
    history: history?.store ?? null,
    logger,
  }).catch(() => undefined);

  const runStore = new LocalRunStore();
  const fileRuns = await runStore.listRuns({ limit: 500 });

  const byId = new Map<string, ListItem>();
  for (const run of fileRuns) {
    byId.set(run.runId, fileRunToItem(run));
  }

  if (history === null) {
    note(
      'note: history index unavailable — showing runs from files only ' +
        '(run `yantra doctor` to rebuild the index)\n',
    );
  } else {
    try {
      const listed = await history.store.list({
        limit: 500,
        ...(before === undefined ? {} : { before }),
      });
      if (listed.isOk) {
        for (const entry of listed.value) {
          byId.set(entry.runId, historyToItem(entry));
        }
      }
    } finally {
      history.close();
    }
  }

  let runs = [...byId.values()].filter((item) => item.kind === 'run');
  if (before !== undefined) runs = runs.filter((item) => newerFirst(before, item) < 0);
  if (query.workflow !== undefined) {
    runs = runs.filter((item) => item.workflowName === query.workflow);
  }
  if (query.status !== undefined) {
    runs = runs.filter((item) => item.status === query.status);
  }
  runs.sort(newerFirst);
  return Promise.all(
    runs.slice(0, limit).map(async (item) => {
      // A corrupt manifest fails only its own detail, never the list.
      const executionState = await readExecutionState(join(runsRoot(), item.runId)).catch(
        () => undefined,
      );
      return executionState === undefined ? item : { ...item, executionState };
    }),
  );
}

function fileRunToItem(run: RunSummary): ListItem {
  return {
    kind: 'run',
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt,
    durationMs: run.durationMs ?? null,
    ...(run.taskOutcome === undefined ? {} : { taskOutcome: run.taskOutcome }),
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
    ...(entry.taskOutcome === null ? {} : { taskOutcome: entry.taskOutcome }),
  };
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}
