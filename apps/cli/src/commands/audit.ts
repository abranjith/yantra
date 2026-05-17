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
import { Command } from 'commander';

import { CLIConnectorIO, buildRenderOpts } from '../connector-io.js';
import { readGlobalFlags } from '../global-flags.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';

import { buildAuditReport } from './audit-builder.js';

interface AuditOptions {
  readonly json?: boolean;
}

export function makeAuditCommand(): Command {
  const cmd = new Command('audit');

  cmd
    .description('Render a run directory as a readable audit story')
    .argument('<run-id>')
    .option('--json', 'emit JSON instead of prose', false)
    .action(async (runId: string, options: AuditOptions) => {
      const flags = readGlobalFlags({
        argv: process.argv,
        env: process.env,
        isTty: process.stdout.isTTY ?? false,
      });
      const isJson = options.json === true || flags.json;
      const renderer = isJson ? new JSONRenderer() : new TerminalRenderer();
      const connector = new CLIConnectorIO(renderer);
      const renderOpts = buildRenderOpts({ ...flags, json: isJson });

      try {
        const runStore = new LocalRunStore();
        const run = await runStore.getRun(runId);
        if (run === null) {
          process.stderr.write(`Run "${runId}" not found.\n`);
          process.exit(1);
        }

        const result = await buildAuditReport(runId, run.runDir);
        if (result.kind === 'err') {
          process.stderr.write(`Audit failed: ${result.error.message}\n`);
          process.exit(1);
        }

        connector.renderResult({ kind: 'audit', report: result.report }, renderOpts);
        process.exit(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}
