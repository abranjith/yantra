/**
 * `yantra report <run-id>` — prints (or opens) the per-run report.md.
 *
 * Stdout path: emits the markdown verbatim. `--open` shells out to
 * `$EDITOR` (or platform default: `notepad.exe`, `open`, `xdg-open`).
 *
 * Deliberately conservative — no shell-out beyond `$EDITOR` and the OS
 * defaults. Memory.md §General "honesty over cleverness" applies here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { LocalRunStore } from '@yantra/core/workflow/replay';
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { buildRenderOpts } from '../connector-io.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { commandFlags } from '../context/flags.js';
import type { HandlerArgs } from '../registry/handler.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';

interface ReportOptions {
  readonly open?: boolean;
  readonly json?: boolean;
}

/** `yantra report`: bound to the `report` registry entry. */
export async function reportHandler(
  args: HandlerArgs,
  options: ReportOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const [runId] = args as readonly [string];
  const flags = commandFlags(context, options);
  const isJson = options.json === true || flags.json;

  try {
    const runStore = new LocalRunStore();
    const run = await runStore.getRun(runId);
    if (run === null) {
      context.output.stderr.write(`Run "${runId}" not found.\n`);
      throw new CommandFailure(1, 'yantra.report.failed', '', null, true);
    }
    const reportPath = join(run.runDir, 'report.md');

    if (options.open === true) {
      if (isJson) {
        context.output.stderr.write('--open is interactive and cannot be combined with --json.\n');
        throw new CommandFailure(1, 'yantra.report.failed', '', null, true);
      }
      if (context.surface === 'worker') context.openExternal(reportPath);
      else if (!(await context.input.editor(reportPath, { wait: false })))
        throw new CommandFailure(1, 'yantra.report.open', 'Failed to launch the report editor.');
      return;
    }

    let markdown: string;
    try {
      markdown = await readFile(reportPath, 'utf8');
    } catch {
      context.output.stderr.write(
        `report.md not found for run ${runId} (the run may still be in progress).\n`,
      );
      throw new CommandFailure(1, 'yantra.report.failed', '', null, true);
    }

    const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
    const connector = context.connector(renderer);
    connector.renderResult(
      { kind: 'report', markdown },
      buildRenderOpts({ ...flags, json: isJson }, context.output),
    );
    return;
  } catch (err) {
    if (err instanceof CommandFailure) throw err;

    const message = err instanceof Error ? err.message : String(err);
    context.output.stderr.write(`Error: ${message}\n`);
    throw new CommandFailure(1, 'yantra.report.failed', '', null, true);
  }
}
