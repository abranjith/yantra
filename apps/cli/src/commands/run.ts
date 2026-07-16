/**
 * `yantra run <workflow-name>` — executes a saved workflow.
 *
 * Wires the inline executor through the {@link RunOrchestrator} from
 * `@yantra/core/workflow/replay`. The orchestrator handles param resolution,
 * preflight, browser launch, plan execution, output evaluation, and report
 * writing; this command is the CLI shell on top of it.
 *
 * @example
 *   yantra run bank-statement --params month=2026-04
 *   yantra run bank-statement --params-file ./params.yaml
 *   yantra run bank-statement --json
 */

import { InteractiveConfirmationGateway } from '@yantra/core';
import type { RunRequest } from '@yantra/core/workflow/replay';
import { exitCodeFor } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

import { recordTaskHistory } from '../history.js';
import { buildOrchestratorRuntime, makeStderrLogger } from '../runtime.js';

interface RunOptions {
  readonly params?: string[];
  readonly paramsFile?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
}

function parseParams(raw: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of raw ?? []) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid --params "${entry}": expected key=value`);
    }
    out[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
  }
  return out;
}

export function makeRunCommand(): Command {
  const cmd = new Command('run');

  cmd
    .description('Execute a saved workflow')
    .argument('<workflow-name>', 'Name of the workflow to run')
    .option(
      '-p, --params <key=value...>',
      'Workflow parameter (may be repeated)',
      collect,
      [] as string[],
    )
    .option('--params-file <path>', 'YAML/JSON file of parameter key-value pairs')
    .option('--json', 'Emit JSON summary to stdout instead of a terminal card', false)
    .option('--debug', 'Emit verbose debug logging to stderr', false)
    .action(async (workflowName: string, options: RunOptions) => {
      const logger = makeStderrLogger(options.debug === true);
      logger.info({ workflowName }, 'yantra run: starting');
      let closeRuntime = (): void => undefined;

      let params: Record<string, string>;
      try {
        params = parseParams(options.params);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      try {
        // Interactive TTY runs can prompt for consent in-process; `--json` and
        // non-TTY surfaces stay fail-closed (no gateway) so they never
        // self-authorize a confirmable step (plan §6).
        const interactive = process.stdin.isTTY === true && options.json !== true;
        const runtime = await buildOrchestratorRuntime({
          logger,
          confirmationGateway: interactive ? new InteractiveConfirmationGateway() : null,
        });
        const { orchestrator } = runtime;
        closeRuntime = runtime.close;

        const request: RunRequest =
          options.paramsFile === undefined
            ? {
                workflowName,
                params,
                budgets: {},
                json: options.json === true,
                debug: options.debug === true,
              }
            : {
                workflowName,
                params,
                paramsFile: options.paramsFile,
                budgets: {},
                json: options.json === true,
                debug: options.debug === true,
              };

        const outcome = await orchestrator.run(request);

        // Record the completed run into the history index (best-effort — the
        // index is an optional cache and must never fail a run).
        if (typeof outcome.runId === 'string' && outcome.runId.length > 0) {
          await recordTaskHistory(outcome.runId);
        }

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        } else {
          const icon = outcome.kind === 'success' ? '✓' : outcome.kind === 'aborted' ? '⤺' : '✗';
          process.stdout.write(`${icon} Run ${outcome.runId}: ${outcome.kind}\n`);
        }

        closeRuntime();
        process.exit(exitCodeFor(outcome));
      } catch (err) {
        closeRuntime();
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        if (options.debug === true && err instanceof Error && err.stack !== undefined) {
          process.stderr.write(`${err.stack}\n`);
        }
        process.exit(1);
      }
    });

  return cmd;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
