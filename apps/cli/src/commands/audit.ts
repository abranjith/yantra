/**
 * `yantra audit <run-id>` — renders the run dir as a human-readable audit story.
 *
 * Strictly read-only: never takes the FEAT-010 run-dir lock; never mutates
 * any file. Builds the structured {@link AuditRenderReport} via
 * {@link buildAuditReport} and dispatches to the configured renderer.
 *
 * @example
 *   yantra audit 20260516T120304Z-bank-statement-a7b3
 *   yantra audit 20260516T120304Z-bank-statement-a7b3 --json
 */

import { LocalRunStore } from '@yantra/core/workflow/replay';
import type { Command } from 'commander';

import { createTerminalContext } from '../adapters/terminal/terminal-adapter.js';
import { buildRenderOpts } from '../connector-io.js';
import { CommandFailure, type CommandContext } from '../context/command-context.js';
import { commandFlags } from '../context/flags.js';
import type { HandlerArgs } from '../registry/handler.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';

import { buildAuditReport } from './audit-builder.js';

interface AuditOptions {
  readonly json?: boolean;
}

/** `yantra audit`: bound to the `audit` registry entry. */
export async function auditHandler(
  args: HandlerArgs,
  options: AuditOptions,
  _command?: Command,
  context: CommandContext = createTerminalContext(),
): Promise<void> {
  const [runId] = args as readonly [string];
  const flags = commandFlags(context, options);
  const isJson = options.json === true || flags.json;
  const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
  const connector = context.connector(renderer);
  const renderOpts = buildRenderOpts({ ...flags, json: isJson }, context.output);

  try {
    const runStore = new LocalRunStore();
    const run = await runStore.getRun(runId);
    if (run === null) {
      context.output.stderr.write(`Run "${runId}" not found.\n`);
      throw new CommandFailure(1, 'yantra.audit.failed', '', null, true);
    }

    const result = await buildAuditReport(runId, run.runDir);
    if (result.kind === 'err') {
      context.output.stderr.write(`Audit failed: ${result.error.message}\n`);
      throw new CommandFailure(1, 'yantra.audit.failed', '', null, true);
    }

    connector.renderResult({ kind: 'audit', report: result.report }, renderOpts);
    return;
  } catch (err) {
    if (err instanceof CommandFailure) throw err;

    const message = err instanceof Error ? err.message : String(err);
    context.output.stderr.write(`Error: ${message}\n`);
    throw new CommandFailure(1, 'yantra.audit.failed', '', null, true);
  }
}
