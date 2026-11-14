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

import {
  FileWorkflowStore,
  queryRunLedger,
  reconcileAll,
  runsRoot,
  workflowsRoot,
  type LedgerKey,
  type Logger,
} from '@yantra/core';
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
export type ListCursorKey = LedgerKey;

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
 * The one builder behind `yantra list --json`. Runs come from the shared
 * Ledger query (`queryRunLedger`, FEAT-066), the same function the app's
 * `read.list` pages with, so the two cannot drift. `note` receives the
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
  return listRuns(query, deps.logger, deps.note);
}

/**
 * Lists runs through the Ledger query: the history index (which includes
 * `ask`/`research` tasks) merged with the run directories, de-duplicated by
 * run id with the index winning. When the index is unavailable it degrades to
 * the file scan alone, with a stderr hint (the "delete index.db, list still
 * works" fallback). Unfinished runs stay in the list (`activeMode: inline`).
 */
async function listRuns(
  query: ListQuery,
  logger: Logger,
  note: (text: string) => void,
): Promise<ListJson> {
  const history = await openHistory(logger);
  try {
    const page = await queryRunLedger(
      {
        limit: query.limit,
        activeMode: 'inline',
        ...(query.before === undefined ? {} : { before: query.before }),
        ...(query.workflow === undefined ? {} : { workflow: query.workflow }),
        ...(query.status === undefined ? {} : { status: query.status }),
      },
      {
        historyStore: history?.store ?? null,
        runsDir: runsRoot(),
        // FEAT-064: end every run whose owner died before reading, so a killed
        // run reads `interrupted`, never `running`. Failures never fail list.
        reconcile: async () => {
          await reconcileAll({
            trigger: 'list',
            includeRunningManifests: true,
            history: history?.store ?? null,
            logger,
          });
        },
      },
    );
    if (history === null) {
      note(
        'note: history index unavailable — showing runs from files only ' +
          '(run `yantra doctor` to rebuild the index)\n',
      );
    }
    return { items: [...page.items], next: page.next };
  } finally {
    history?.close();
  }
}

function parseLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}
