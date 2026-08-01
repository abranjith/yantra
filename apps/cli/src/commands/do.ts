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
  type AgentBudgetConfig,
  type AgenticTaskOutcome,
} from '@yantra/agent';
import { validateTemplatedReport } from '@yantra/protocol';
import { CommanderError, Option, type Command } from 'commander';

import {
  addAgentModelOptions,
  selectAgentSession,
  type AgentModelOptions,
} from '../agent-model.js';
import { CLIConnectorIO } from '../connector-io.js';
import { recordTaskHistory } from '../history.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ConnectorRenderOpts } from '../render/types.js';
import { runAgenticTaskWithRankSink } from '../runtime.js';
import {
  TEMPLATE_LLM_GUARD,
  TEMPLATE_OPTION_DESCRIPTION,
  resolveTemplateRef,
} from '../template-ref.js';

interface DoOptions extends AgentModelOptions {
  readonly json?: boolean;
  readonly llm?: boolean;
  readonly template?: string;
  readonly allowHost?: string[];
  readonly budgetMs?: string;
  readonly maxToolCalls?: string;
  readonly maxCallsPerTool?: string;
  readonly toolTimeoutMs?: string;
  readonly maxProviderTokens?: string;
  readonly maxCostUsd?: string;
  readonly confirmationTimeoutMs?: string;
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
}

/** Register `do`/`discover` without introducing any agent loop in the CLI. */
export function registerDoCommand(program: Command, runtime?: Partial<DoRuntime>): void {
  const resolved = runtimeWithDefaults(runtime);
  const command = program
    .command('do')
    .alias('discover')
    .description('Run a multi-turn web agent that uses Yantra tools and publishes a Brief.')
    .argument('<goal>', 'browser or web goal to accomplish');
  addAgentModelOptions(command)
    .addOption(
      new Option('--allow-host <host>', 'restrict outbound work to a host (repeatable)')
        .argParser(collect)
        .default([]),
    )
    .addOption(new Option('--budget-ms <ms>', 'whole-run wall-clock budget'))
    .addOption(new Option('--max-tool-calls <n>', 'maximum total tool calls'))
    .addOption(new Option('--max-calls-per-tool <n>', 'maximum calls to one tool'))
    .addOption(new Option('--tool-timeout-ms <ms>', 'timeout for one tool call'))
    .addOption(new Option('--max-provider-tokens <n>', 'approximate provider token ceiling'))
    .addOption(new Option('--max-cost-usd <amount>', 'approximate provider cost ceiling'))
    .addOption(new Option('--confirmation-timeout-ms <ms>', 'maximum live consent wait'))
    .addOption(
      new Option(
        '--save-as <name>',
        'on success, promote the browser trace into a saved, replayable workflow',
      ),
    )
    .addOption(new Option('--json', 'emit progress and outcome as NDJSON').default(false))
    .addOption(new Option('--template <name|tag|path>', TEMPLATE_OPTION_DESCRIPTION))
    .addOption(new Option('--no-llm', 'disable LLM mode'))
    .action((goal: string, options: DoOptions) => executeDo(goal, options, resolved));
}

/** Map a closed agentic result to the documented CLI contract. */
export const exitCodeForDoOutcome = exitCodeForAgenticOutcome;

async function executeDo(goal: string, options: DoOptions, runtime: DoRuntime): Promise<void> {
  const noLlm = options.llm === false || runtime.env.LLM_PROVIDER === 'none';
  if (options.template !== undefined && noLlm) {
    runtime.stderr.write(`${TEMPLATE_LLM_GUARD}\n`);
    throw new CommanderError(1, 'yantra.template.llm-required', TEMPLATE_LLM_GUARD);
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
    const agent = selectAgentSession('do', options, runtime.env);
    const outcome = await runtime.runTask({
      goal,
      profile,
      model: agent.model,
      auth: agent.auth,
      budgets: parseBudgets(options),
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

function parseBudgets(options: DoOptions): Partial<AgentBudgetConfig> {
  const wallClockMs = positiveInteger(options.budgetMs, '--budget-ms');
  const totalToolCalls = positiveInteger(options.maxToolCalls, '--max-tool-calls');
  const perToolCalls = positiveInteger(options.maxCallsPerTool, '--max-calls-per-tool');
  const perToolTimeoutMs = positiveInteger(options.toolTimeoutMs, '--tool-timeout-ms');
  const maxProviderTokens = positiveInteger(options.maxProviderTokens, '--max-provider-tokens');
  const maxProviderCostUsd = positiveNumber(options.maxCostUsd, '--max-cost-usd');
  const confirmationWaitMs = positiveInteger(
    options.confirmationTimeoutMs,
    '--confirmation-timeout-ms',
  );
  return {
    ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    ...(totalToolCalls !== undefined ? { totalToolCalls } : {}),
    ...(perToolCalls !== undefined ? { perToolCalls } : {}),
    ...(perToolTimeoutMs !== undefined ? { perToolTimeoutMs } : {}),
    ...(maxProviderTokens !== undefined ? { maxProviderTokens } : {}),
    ...(maxProviderCostUsd !== undefined ? { maxProviderCostUsd } : {}),
    ...(confirmationWaitMs !== undefined ? { confirmationWaitMs } : {}),
  };
}

function positiveInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CommanderError(1, 'yantra.do.invalid-budget', `${flag} must be a positive integer.`);
  }
  return parsed;
}

function positiveNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CommanderError(1, 'yantra.do.invalid-budget', `${flag} must be positive.`);
  }
  return parsed;
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
  };
}

export type { AgenticTaskOutcome };
