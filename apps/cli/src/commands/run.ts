/**
 * `yantra run <workflow-name>` — executes a saved workflow.
 *
 * Wires the inline executor through the {@link RunOrchestrator} from
 * `@yantra/core/workflow/replay`. The orchestrator handles param resolution,
 * preflight, browser launch, plan execution, output evaluation, synthesis, and
 * report writing; this command is the CLI shell on top of it.
 *
 * A workflow declaring a `synthesis:` block ends in a Brief. **The workflow, not
 * the command line, decides how that Brief is written**: `synthesis.use_llm`
 * (set when the workflow was promoted from a model-authored run) selects the LLM
 * synthesizer; anything else composes the document deterministically, opening no
 * provider session. So `yantra run <name>` reproduces what the workflow was
 * saved as, the way `ask` and `do` need no mode flag to do what they do.
 *
 * `--no-llm` is the escape hatch — it forces the deterministic path even for a
 * workflow that asked for a model — and mirrors the same flag on `ask` and
 * `research`. The shared `--provider` / `--model` / `--thinking` /
 * `--auth-secret` surface picks *which* model, exactly as on the agentic
 * commands.
 *
 * @example
 *   yantra run bank-statement --params month=2026-04
 *   yantra run bank-statement --params-file ./params.yaml
 *   yantra run bank-statement --json
 *   yantra run quarterly-report --model claude-sonnet-5
 *   yantra run quarterly-report --no-llm
 */

import { readFile } from 'node:fs/promises';

import { PiAgentProvider } from '@yantra/agent';
import { InteractiveConfirmationGateway, type EffectivePreferences } from '@yantra/core';
import type { BriefRunArtifacts, RunRequest } from '@yantra/core/workflow/replay';
import { exitCodeFor } from '@yantra/core/workflow/replay';
import type { Brief } from '@yantra/protocol';
import { validateBrief } from '@yantra/protocol';
import { Command } from 'commander';

import {
  addAgentOptions,
  resolveAgentInvocation,
  type AgentInvocationDependencies,
  type AgentInvocation,
  type AgentOptions,
} from '../agent-options.js';
import { CLIConnectorIO } from '../connector-io.js';
import { recordTaskHistory } from '../history.js';
import { loadEffectivePreferences } from '../preferences.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ConnectorRenderOpts } from '../render/types.js';
import { buildOrchestratorRuntime, makeStderrLogger } from '../runtime.js';
import { createSynthesisLlm } from '../synthesis-llm.js';

interface RunOptions extends AgentOptions {
  readonly params?: string[];
  readonly paramsFile?: string;
  readonly json?: boolean;
  readonly debug?: boolean;
  /**
   * `--no-llm`; commander stores it as `llm: false`. Undefined (the default)
   * leaves the decision to the workflow's `synthesis.use_llm`.
   */
  readonly llm?: boolean;
  /** Registered only to provide a pointed unsupported-surface error. */
  readonly template?: string;
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
    .option('--template <ref>', 'report templates are supported on ask, research, and do');

  addAgentOptions(cmd).action(async (workflowName: string, options: RunOptions) => {
    if (options.template !== undefined) {
      process.stderr.write(
        'templates are not yet supported on run; see docs/features/report-templates.md\n',
      );
      process.exit(1);
    }
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

    // Resolved BEFORE the try block so a bad `--provider`/`--model` stays a
    // validation failure (exit 1) rather than being reported as an execution
    // error after a run directory already exists — the `ask` precedent.
    let wiring: RunSynthesisWiring = { noLlm: true, selection: null };
    try {
      wiring = await resolveRunSynthesis(options, process.env, await loadEffectivePreferences());
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    const { selection } = wiring;
    if (wiring.reason === 'unavailable' && wiring.unavailableModel !== undefined) {
      process.stderr.write(
        `warning: model ${wiring.unavailableModel.provider}/${wiring.unavailableModel.id} is unavailable because no credential resolved; ` +
          'configure provider auth or pass --auth-secret <ref>; using deterministic replay synthesis\n',
      );
    }

    try {
      // Interactive TTY runs can prompt for consent in-process; `--json` and
      // non-TTY surfaces stay fail-closed (no gateway) so they never
      // self-authorize a confirmable step (plan §6).
      const interactive = process.stdin.isTTY === true && options.json !== true;
      const runtime = await buildOrchestratorRuntime({
        logger,
        confirmationGateway: interactive ? new InteractiveConfirmationGateway() : null,
        // The stage is always wired for `run`, so a workflow declaring
        // `synthesis:` always gets a Brief. The *strategy* is the workflow's
        // call: the port below is only ever built for a workflow whose
        // `synthesis.use_llm` is set, so an ordinary replay opens no session.
        synthesis: {
          noLlm: wiring.noLlm,
          llm:
            selection === null
              ? null
              : ({ runId, runDir }) =>
                  createSynthesisLlm({
                    // Zero tools: the session is a pure completion endpoint.
                    provider: new PiAgentProvider(),
                    model: selection.model,
                    auth: selection.auth,
                    runId,
                    runDir,
                    cwd: process.cwd(),
                    logger,
                  }),
        },
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

      // A run that synthesized a Brief has a real document to show; reading it
      // back from the artifact the stage just wrote keeps the outcome type
      // serializable for `--json`.
      const briefArtifacts = outcome.kind === 'success' ? outcome.brief : undefined;
      const brief = briefArtifacts === undefined ? null : await readBrief(briefArtifacts);

      if (options.json === true) {
        process.stdout.write(
          `${JSON.stringify(
            brief === null ? outcome : { ...outcome, briefDocument: brief },
            null,
            2,
          )}\n`,
        );
      } else {
        const icon = outcome.kind === 'success' ? '✓' : outcome.kind === 'aborted' ? '⤺' : '✗';
        process.stdout.write(`${icon} Run ${outcome.runId}: ${outcome.kind}\n`);
        if (outcome.kind === 'success') {
          if (brief === null) {
            process.stdout.write(renderOutputs(outcome.outputs));
          } else {
            // The Brief *is* the run's answer — render it the way `ask` does
            // rather than dumping the raw captures it was synthesized from.
            renderBrief(brief, briefArtifacts ?? null);
          }
        }
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

/**
 * The Synthesize-stage wiring implied by the run's flags.
 *
 * Extracted as a pure function because it encodes the command's central
 * property — **the workflow decides, the flag can only veto** — and that
 * deserves direct test coverage rather than being buried in the command action.
 */
export interface RunSynthesisWiring {
  /**
   * True when the user vetoed the model (`--no-llm` / `LLM_PROVIDER=none`).
   * A veto only: `false` does not mean a model *will* be used, it means the
   * workflow's `synthesis.use_llm` is allowed to decide.
   */
  readonly noLlm: boolean;
  /**
   * The resolved provider session coordinates, or null when the user vetoed the
   * model. These are *coordinates only* — the adapter is constructed lazily, and
   * only for a workflow that declared `synthesis.use_llm`.
   */
  readonly selection: Extract<AgentInvocation, { readonly mode: 'llm' }> | null;
  /** Why deterministic synthesis was selected, when applicable. */
  readonly reason?: Extract<AgentInvocation, { readonly mode: 'no-llm' }>['reason'];
  readonly unavailableModel?: Extract<AgentInvocation, { readonly reason: 'unavailable' }>['model'];
}

/**
 * Resolves whether this run may use a model, and with what coordinates.
 *
 * Resolution happens before execution starts so an invalid `--provider` or
 * `--model` is a *validation* failure (exit 1), matching `ask` — which resolves
 * the same surface up front for the same reason. Resolving is pure: it reads
 * flags and environment, contacts nothing, and opens no session.
 *
 * @param options - The parsed `run` flags.
 * @param env - Process environment, consulted for `YANTRA_AGENT_*` defaults and
 *   the `LLM_PROVIDER=none` opt-out that `ask` and `research` already honor.
 * @returns The wiring; `selection` is null exactly when the model was vetoed.
 * @throws CommanderError (exit code 1) on an invalid provider/model/auth
 *   reference, unless the model was vetoed (nothing to validate then).
 */
export async function resolveRunSynthesis(
  options: RunOptions,
  env: NodeJS.ProcessEnv,
  prefs: EffectivePreferences = new Map(),
  dependencies: AgentInvocationDependencies = {},
): Promise<RunSynthesisWiring> {
  const invocation = await resolveAgentInvocation('run', options, env, prefs, dependencies);
  if (invocation.mode === 'llm') return { noLlm: false, selection: invocation };
  return invocation.reason === 'unavailable'
    ? {
        noLlm: true,
        selection: null,
        reason: invocation.reason,
        unavailableModel: invocation.model,
      }
    : { noLlm: true, selection: null, reason: invocation.reason };
}

/**
 * Reads back the Brief the Synthesize stage just wrote.
 *
 * Best-effort and validated: a missing or malformed `brief.json` falls back to
 * the ordinary outputs rendering rather than failing a run that already
 * succeeded.
 */
async function readBrief(artifacts: BriefRunArtifacts): Promise<Brief | null> {
  try {
    const parsed = validateBrief(JSON.parse(await readFile(artifacts.jsonPath, 'utf8')));
    return parsed.isOk ? parsed.value : null;
  } catch {
    return null;
  }
}

/** Renders a Brief through the same connector dispatch `ask` uses. */
function renderBrief(brief: Brief, artifacts: BriefRunArtifacts | null): void {
  const io = new CLIConnectorIO(new TerminalRenderer());
  const stdout = process.stdout;
  const opts: ConnectorRenderOpts = {
    json: false,
    debug: false,
    noColor: process.env.NO_COLOR !== undefined,
    stream: process.stdout,
    errStream: process.stderr,
    briefDetail: 'standard',
    briefFormat: 'terminal',
    ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
  };

  io.renderResult({ kind: 'brief', brief, artifacts }, opts);
}

/** Longest output body shown inline; the rest is in the run's `outputs.json`. */
const MAX_OUTPUT_CHARS = 4_000;

/**
 * Renders a successful run's outputs beneath the status line.
 *
 * A run that completes and prints only `✓ Run <id>: success` is
 * indistinguishable from one that did nothing — the whole point of replaying a
 * workflow is the data it collects, and until now that data was reachable only
 * by opening `outputs.json` or re-running with `--json`.
 *
 * Long values are truncated with a pointer to the full artifact rather than
 * flooding the terminal; `--json` remains the lossless surface for scripting.
 */
export function renderOutputs(outputs: Readonly<Record<string, unknown>>): string {
  const entries = Object.entries(outputs);
  if (entries.length === 0) {
    return (
      '\nThis workflow declares no outputs, so the run captured nothing to show.\n' +
      'Add an `extract` step (or re-save the workflow with `yantra do --save-as`) to collect data.\n' +
      'To end the run with a synthesized Brief instead, add a `synthesis:` block naming the\n' +
      'question it should answer.\n'
    );
  }
  const lines: string[] = [''];
  for (const [name, value] of entries) {
    const rendered = renderOutputValue(value);
    const truncated =
      rendered.length > MAX_OUTPUT_CHARS
        ? `${rendered.slice(0, MAX_OUTPUT_CHARS)}\n… truncated — see outputs.json for the full value`
        : rendered;
    lines.push(`${name}:`);
    for (const line of truncated.split('\n')) lines.push(`  ${line}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderOutputValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  // Objects, arrays, and anything else an extraction can produce. `JSON.stringify`
  // rather than `String(value)`, which renders every object as `[object Object]`.
  return JSON.stringify(value, null, 2) ?? String(typeof value);
}
