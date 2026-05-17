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

import type { RunRequest } from '@yantra/core/workflow/replay';
import { exitCodeFor } from '@yantra/core/workflow/replay';
import { Command } from 'commander';

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

      let params: Record<string, string>;
      try {
        params = parseParams(options.params);
      } catch (err) {
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      }

      try {
        const { orchestrator } = await buildOrchestratorRuntime({ logger });

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

        if (options.json === true) {
          process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
        } else {
          const icon = outcome.kind === 'success' ? '✓' : outcome.kind === 'aborted' ? '⤺' : '✗';
          process.stdout.write(`${icon} Run ${outcome.runId}: ${outcome.kind}\n`);
        }

        process.exit(exitCodeFor(outcome));
      } catch (err) {
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
