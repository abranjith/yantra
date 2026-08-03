/**
 * `yantra do "<goal>"` â€” the CLI shell around the agentic runtime.
 *
 * The command owns argument parsing, model/auth selection, connector rendering,
 * and exit-code mapping only. The reasoning/tool loop lives exclusively in
 * `runAgenticTask()` inside `@yantra/agent`.
 */

import { readFile } from 'node:fs/promises';

import {
  exitCodeForAgenticOutcome,
  resolveCommandTaskProfile,
  type runAgenticTask,
  type ActiveReportTemplate,
  type AgenticTaskOutcome,
} from '@yantra/agent';
import type { EffectivePreferences } from '@yantra/core';
import { validateTemplatedReport } from '@yantra/protocol';
import { CommanderError, Option, type Command } from 'commander';

import { addAgentOptions, resolveAgentInvocation, type AgentOptions } from '../agent-options.js';
import { CLIConnectorIO } from '../connector-io.js';
import { recordTaskHistory } from '../history.js';
import { loadEffectivePreferences } from '../preferences.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ConnectorRenderOpts } from '../render/types.js';
import { runAgenticTaskWithRankSink } from '../runtime.js';
import {
  TEMPLATE_LLM_GUARD,
  TEMPLATE_OPTION_DESCRIPTION,
  resolveTemplateRef,
} from '../template-ref.js';

interface DoOptions extends AgentOptions {
  readonly json?: boolean;
  readonly llm?: boolean;
  readonly template?: string;
  readonly allowHost?: string[];
  /** Promote a successful run's browser trace into a saved workflow (FEAT-027). */
  readonly saveAs?: string;
}

/** Injectable CLI boundaries for hermetic command tests. */
export interface DoRuntime {
  readonly runTask: typeof runAgenticTask;
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly isTty: boolean;
  readonly resolveTemplate: (ref: string) => Promise<ActiveReportTemplate>;
  readonly recordHistory: (runId: string) => Promise<void>;
  readonly resolveDefaults: () => Promise<EffectivePreferences>;
  readonly resolveAgent: typeof resolveAgentInvocation;
}

/** Register `do`/`discover` without introducing any agent loop in the CLI. */
export function registerDoCommand(program: Command, runtime?: Partial<DoRuntime>): void {
  const resolved = runtimeWithDefaults(runtime);
  const command = program
    .command('do')
    .alias('discover')
    .description('Run a multi-turn web agent that uses Yantra tools and publishes a Brief.')
    .argument('<goal>', 'browser or web goal to accomplish');
  addAgentOptions(command)
    .addOption(
      new Option('--allow-host <host>', 'restrict outbound work to a host (repeatable)')
        .argParser(collect)
        .default([]),
    )
    .addOption(
      new Option(
        '--save-as <name>',
        'on success, promote the browser trace into a saved, replayable workflow',
      ),
    )
    .addOption(new Option('--json', 'emit progress and outcome as NDJSON').default(false))
    .addOption(new Option('--template <name|tag|path>', TEMPLATE_OPTION_DESCRIPTION))
    .action((goal: string, options: DoOptions) => executeDo(goal, options, resolved));
}

/** Map a closed agentic result to the documented CLI contract. */
export const exitCodeForDoOutcome = exitCodeForAgenticOutcome;

async function executeDo(goal: string, options: DoOptions, runtime: DoRuntime): Promise<void> {
  const effective = await runtime.resolveDefaults();
  const agent = await runtime.resolveAgent('do', options, runtime.env, effective);
  if (agent.mode === 'no-llm') {
    if (agent.reason === 'unavailable') {
      const message =
        `No credentials available for provider "${agent.model.provider}". ` +
        'Set the provider API key, seed managed auth, or pass --auth-secret <ref>.';
      runtime.stderr.write(`AGENT_AUTH_UNAVAILABLE: ${message}\n`);
      throw new CommanderError(3, 'AGENT_AUTH_UNAVAILABLE', message);
    }
    const message =
      options.template === undefined
        ? '`do` runs a web agent and requires a model; use `ask --no-llm` or ' +
          '`research --no-llm` for deterministic web research.'
        : TEMPLATE_LLM_GUARD;
    runtime.stderr.write(`${message}\n`);
    throw new CommanderError(1, 'yantra.do.llm-required', message);
  }
  const template =
    options.template === undefined
      ? undefined
      : await runtime.resolveTemplate(options.template).catch((error: unknown) => {
          runtime.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
          throw error;
        });
  const json = options.json === true;
  const renderOpts: ConnectorRenderOpts = {
    json,
    debug: false,
    noColor: json || !runtime.isTty,
    stream: runtime.stdout,
    errStream: runtime.stderr,
  };
  const connector = new CLIConnectorIO(json ? new JSONRenderer() : new TerminalRenderer(), {
    renderOpts,
    interactive: runtime.isTty && !json,
    suppressPublishedOutcome: template !== undefined,
  });
  const abort = new AbortController();
  const onInterrupt = (): void => abort.abort('user-interrupt');
  process.once('SIGINT', onInterrupt);

  try {
    const saveAs = options.saveAs?.trim();
    // Resolve the least-privilege `do` profile explicitly (tool allowlist,
    // workflow mode, budgets, task-Brief addendum) instead of relying on the
    // runtime's implicit default. This also honors the documented
    // `YANTRA_AGENT_DO_*` budget env overrides, matching the `ask` path.
    const profile = resolveCommandTaskProfile('do', runtime.env);
    const outcome = await runtime.runTask({
      goal,
      profile,
      model: agent.model,
      auth: agent.auth,
      budgets: agent.budgets,
      allowedHosts: normalizeHosts(options.allowHost ?? []),
      // A user is present only on an interactive TTY run (not --json / piped):
      // the agent prompt then says a user can approve protected actions but
      // cannot answer open-ended questions, instead of claiming "no user".
      interactive: runtime.isTty && !json,
      ...(saveAs && saveAs.length > 0 ? { saveAs } : {}),
      ...(template === undefined ? {} : { template }),
      connector,
      signal: abort.signal,
    });
    if (template !== undefined && outcome.kind === 'published') {
      const parsed = validateTemplatedReport(
        JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown,
      );
      if (!parsed.isOk) {
        throw new CommanderError(
          2,
          'yantra.do.invalid-templated-report',
          'The agent published an invalid templated report artifact.',
        );
      }
      connector.renderResult(
        {
          kind: 'templated_report',
          report: parsed.value,
          artifacts: {
            jsonPath: outcome.brief.jsonPath,
            mdPath: outcome.brief.markdownPath,
            htmlPath: outcome.brief.htmlPath,
          },
        },
        renderOpts,
      );
      await runtime.recordHistory(outcome.runId);
    }
    if (!json && outcome.kind === 'published' && outcome.promotion) {
      const line = outcome.promotion.saved
        ? `✓ Saved workflow "${outcome.promotion.workflowName}". Replay it with: yantra run ${outcome.promotion.workflowName}\n`
        : `⚠ Could not save workflow "${outcome.promotion.workflowName}": ${outcome.promotion.error}\n`;
      runtime.stdout.write(line);
    }
    const exitCode = exitCodeForDoOutcome(outcome);
    if (exitCode !== 0) {
      throw new CommanderError(exitCode, `yantra.do.${outcome.kind}`, outcome.kind);
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const normalized = hosts.map(clean).map((host) => host.toLowerCase());
  for (const host of normalized) {
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(host)) {
      throw new CommanderError(
        1,
        'yantra.do.invalid-host',
        `Invalid --allow-host value "${host}".`,
      );
    }
  }
  return [...new Set(normalized)].sort();
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function clean(value: string): string {
  return value.trim();
}

function runtimeWithDefaults(runtime?: Partial<DoRuntime>): DoRuntime {
  return {
    runTask: runtime?.runTask ?? runAgenticTaskWithRankSink,
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    isTty: runtime?.isTty ?? process.stdin.isTTY === true,
    resolveTemplate:
      runtime?.resolveTemplate ??
      ((ref) => resolveTemplateRef(ref, { isTty: runtime?.isTty ?? process.stdin.isTTY === true })),
    recordHistory: runtime?.recordHistory ?? ((runId) => recordTaskHistory(runId)),
    resolveDefaults: runtime?.resolveDefaults ?? (() => loadEffectivePreferences()),
    resolveAgent: runtime?.resolveAgent ?? resolveAgentInvocation,
  };
}

export type { AgenticTaskOutcome };
