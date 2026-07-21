/**
 * `yantra do "<goal>"` â€” the CLI shell around the agentic runtime.
 *
 * The command owns argument parsing, model/auth selection, connector rendering,
 * and exit-code mapping only. The reasoning/tool loop lives exclusively in
 * `runAgenticTask()` inside `@yantra/agent`.
 */

import {
  exitCodeForAgenticOutcome,
  resolveCommandTaskProfile,
  type runAgenticTask,
  type AgentBudgetConfig,
  type AgenticTaskOutcome,
  type AgenticTaskRequest,
} from '@yantra/agent';
import { CommanderError, Option, type Command } from 'commander';

import { CLIConnectorIO } from '../connector-io.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { ConnectorRenderOpts } from '../render/types.js';
import { runAgenticTaskWithRankSink } from '../runtime.js';

const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-haiku-4-5';

interface DoOptions {
  readonly json?: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly authSecret?: string;
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
}

/** Register `do`/`discover` without introducing any agent loop in the CLI. */
export function registerDoCommand(program: Command, runtime?: Partial<DoRuntime>): void {
  const resolved = runtimeWithDefaults(runtime);
  program
    .command('do')
    .alias('discover')
    .description('Run a multi-turn web agent that uses Yantra tools and publishes a Brief.')
    .argument('<goal>', 'browser or web goal to accomplish')
    .addOption(new Option('--provider <name>', 'agent model provider'))
    .addOption(new Option('--model <id>', 'provider-scoped model id'))
    .addOption(new Option('--thinking <level>', 'provider reasoning level'))
    .addOption(new Option('--auth-secret <ref>', 'runtime model-key secret reference'))
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
    .action((goal: string, options: DoOptions) => executeDo(goal, options, resolved));
}

/** Map a closed agentic result to the documented CLI contract. */
export const exitCodeForDoOutcome = exitCodeForAgenticOutcome;

async function executeDo(goal: string, options: DoOptions, runtime: DoRuntime): Promise<void> {
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
      model: selectModel(options, runtime.env),
      auth: options.authSecret
        ? { mode: 'runtime-key', secretRef: options.authSecret }
        : { mode: 'managed' },
      budgets: parseBudgets(options),
      allowedHosts: normalizeHosts(options.allowHost ?? []),
      // A user is present only on an interactive TTY run (not --json / piped):
      // the agent prompt then says a user can approve protected actions but
      // cannot answer open-ended questions, instead of claiming "no user".
      interactive: runtime.isTty && !json,
      ...(saveAs && saveAs.length > 0 ? { saveAs } : {}),
      connector,
      signal: abort.signal,
    });
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

function selectModel(options: DoOptions, env: NodeJS.ProcessEnv): AgenticTaskRequest['model'] {
  const provider = clean(options.provider ?? env.YANTRA_AGENT_PROVIDER ?? DEFAULT_PROVIDER);
  const model = clean(options.model ?? env.YANTRA_AGENT_MODEL ?? DEFAULT_MODEL);
  if (provider.length === 0 || model.length === 0) {
    throw new CommanderError(1, 'yantra.do.invalid-model', 'Provider and model must be non-empty.');
  }
  return {
    provider,
    id: model,
    ...(options.thinking && clean(options.thinking).length > 0
      ? { thinking: clean(options.thinking) }
      : {}),
  };
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
  };
}

export type { AgenticTaskOutcome };
