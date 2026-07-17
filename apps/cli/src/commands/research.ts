import { readFile } from 'node:fs/promises';

import {
  resolveCommandTaskProfile,
  runAgenticTask,
  type AgenticTaskOutcome,
  type AgenticTaskRequest,
} from '@yantra/agent';
import {
  BlocklistImpl,
  BrowserFallbackFetcher,
  DeterministicSynthesizer,
  EthicsGateImpl,
  FollowUpQueryGenerator,
  HttpFetcher,
  HybridContentFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  ResearchLoop,
  RobotsCacheImpl,
  createAskEthicsAdapter,
  createKeychainProvider,
  loadEthicsConfig,
  loadSearchConfig,
  resolveSearchProvider,
  type Logger,
  type ResearchOptions,
  type ResearchRunResult,
  type SearchProviderName,
  type SynthesisLength,
} from '@yantra/core';
import { validateBrief } from '@yantra/protocol';
import { CommanderError, Option, type Command } from 'commander';

import { CLIConnectorIO } from '../connector-io.js';
import { openArtifact } from '../open-artifact.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { BriefDetailLevel, BriefOutputFormat, ConnectorRenderOpts } from '../render/types.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface ResearchCommandOptions {
  readonly json?: boolean;
  readonly llm?: boolean;
  readonly color?: boolean;
  readonly open?: boolean;
  readonly depth?: string;
  readonly maxSources?: string;
  readonly detail?: string;
  readonly format?: string;
  readonly length?: string;
  readonly searchProvider?: string;
  readonly budget?: string;
  readonly fetchTimeout?: string;
  readonly budgetMs?: string;
  readonly perQueryLimit?: string;
}

/** The parsed inputs a research invocation needs. */
export interface ResearchInvocation {
  readonly options: ResearchOptions;
  readonly searchProvider: SearchProviderName | null;
}

export interface ResearchRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly createLoop: (invocation: ResearchInvocation) => Promise<ResearchLoop>;
  readonly runTask: typeof runAgenticTask;
  readonly isTty: boolean;
}

/**
 * Registers the `research` subcommand: a bounded multi-hop
 * `search → fetch → synthesize → follow-up → repeat` loop producing one
 * long-form Brief (styled terminal / md / html / json).
 */
export function registerResearchCommand(
  program: Command,
  runtime?: Partial<ResearchRuntime>,
): void {
  const resolvedRuntime = runtimeWithDefaults(runtime);

  program
    .command('research')
    .description('Deep, multi-hop research on a topic, returned as a long-form Brief.')
    .argument('<topic>', 'topic to research from web sources')
    .addOption(new Option('--json', 'shorthand for --format json').default(false))
    .addOption(
      new Option('--depth <hops>', 'number of research hops (1-3)')
        .choices(['1', '2', '3'])
        .default('2'),
    )
    .addOption(new Option('--max-sources <n>', 'maximum sources to gather').default('24'))
    .addOption(
      new Option('--detail <level>', 'terminal disclosure level')
        .choices(['overview', 'standard', 'full'])
        .default('standard'),
    )
    .addOption(
      new Option('--format <format>', 'output format sent to stdout')
        .choices(['terminal', 'md', 'html', 'json'])
        .default('terminal'),
    )
    .addOption(
      new Option('--length <length>', 'final synthesis length budget')
        .choices(['short', 'medium', 'long'])
        .default('long'),
    )
    .addOption(new Option('--open', 'open the generated brief.html in the default browser'))
    .addOption(new Option('--no-llm', 'force the deterministic (no-LLM) path'))
    .addOption(new Option('--no-color', 'disable ANSI color output'))
    .addOption(
      new Option(
        '--search-provider <provider>',
        'search provider (default: auto walks tavily -> brave -> duckduckgo)',
      ).choices(['auto', 'google', 'duckduckgo', 'brave', 'tavily']),
    )
    .addOption(new Option('--budget <calls>', 'maximum LLM calls across the run'))
    .addOption(
      new Option('--per-query-limit <n>', 'search results to consider per query').default('6'),
    )
    .addOption(new Option('--fetch-timeout <ms>', 'per-fetch timeout in ms').default('8000'))
    .addOption(
      new Option(
        '--budget-ms <ms>',
        'deterministic loop wall-clock budget in ms; for agentic runs, an opt-in wall-clock limit (unlimited when omitted)',
      ).default('180000'),
    )
    .action(async (topicArg: string, options: ResearchCommandOptions, command: Command) => {
      const invocation = buildInvocation(topicArg, options, resolvedRuntime.env);
      const format = resolveFormat(options);
      const detail = (options.detail ?? 'standard') as BriefDetailLevel;

      resolvedRuntime.stderr.write(
        `research: provider=${invocation.searchProvider ?? 'auto'} ` +
          `depth=${invocation.options.budget.maxHops} max-sources=${invocation.options.budget.maxSources} ` +
          `no-llm=${invocation.options.noLlm} detail=${detail} format=${format}\n`,
      );

      try {
        // Deterministic selection is resolved before any agent/provider setup.
        if (!invocation.options.noLlm) {
          // Agentic wall clock is unlimited unless --budget-ms was passed
          // explicitly; the deterministic loop below keeps its bounded default.
          const explicitWallClockMs =
            command.getOptionValueSource('budgetMs') === 'cli'
              ? invocation.options.budget.maxWallClockMs
              : null;
          await runAgenticResearch(
            topicArg,
            invocation,
            format,
            detail,
            options,
            resolvedRuntime,
            explicitWallClockMs,
          );
          return;
        }
        const loop = await resolvedRuntime.createLoop(invocation);
        const result: ResearchRunResult = await loop.run(invocation.options);

        renderBrief(resolvedRuntime, result, { format, detail, options });

        if (options.open === true && result.artifacts !== null) {
          openArtifact(result.artifacts.htmlPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolvedRuntime.stderr.write(`research failed: ${message}\n`);
        throw new CommanderError(2, 'yantra.research.failed', message);
      }
    });
}

/** Renders the Brief through the unified connector dispatch (same as `ask`). */
function renderBrief(
  runtime: ResearchRuntime,
  result: ResearchRunResult,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: ResearchCommandOptions },
): void {
  const renderer = view.format === 'json' ? new JSONRenderer() : new TerminalRenderer();
  const io = new CLIConnectorIO(renderer);
  const stdout = runtime.stdout as NodeJS.WriteStream;

  const opts: ConnectorRenderOpts = {
    json: view.format === 'json',
    debug: false,
    noColor: resolveNoColor(view.options, runtime),
    stream: runtime.stdout,
    errStream: runtime.stderr,
    briefDetail: view.detail,
    briefFormat: view.format,
    ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
  };

  io.renderResult({ kind: 'brief', brief: result.brief, artifacts: result.artifacts }, opts);
}

/**
 * Constructs the default research loop. Like `ask`, the synthesizer and
 * query generator use the deterministic strategies by default (the
 * agent-optional invariant); the LLM ports are injected in tests and will be
 * wired to the shared live agent runtime alongside agentic `ask` synthesis.
 */
export async function createDefaultResearchLoop(
  invocation: ResearchInvocation,
): Promise<ResearchLoop> {
  const logger = noopLogger;

  const profileStore = new LocalProfileStore({ logger });
  const browserProvider = new LocalBrowserProvider({ profileStore, logger });

  const ethicsConfig = await loadEthicsConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const robots = new RobotsCacheImpl(ethicsConfig.userAgent);
  const rateLimiter = new RateLimiterImpl(
    ethicsConfig.rateLimitDefault,
    ethicsConfig.rateLimitOverrides,
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  );
  const ethicsGate = new EthicsGateImpl(blocklist, robots, rateLimiter, ethicsConfig.userAgent, {
    enforceRobotsTxt: ethicsConfig.robotsEnabled,
  });
  const askEthicsGate = createAskEthicsAdapter(ethicsGate, {
    taskId: 'research',
    runId: 'research',
    stepId: 'research',
    action: 'fetch',
  });

  const keychain = await createKeychainProvider();
  const searchConfig = await loadSearchConfig();
  const resolved = await resolveSearchProvider({
    explicitProvider: invocation.searchProvider,
    env: process.env,
    config: searchConfig,
    deps: { keychain, browserProvider, ethicsGate: askEthicsGate, logger },
  });
  if (!resolved.isOk) {
    throw resolved.error;
  }

  const fetcher = new HybridContentFetcher({
    httpFetcher: new HttpFetcher(),
    browserFetcher: new BrowserFallbackFetcher({ browserProvider }),
  });

  return new ResearchLoop({
    searchProvider: resolved.value,
    fetcher,
    extractor: new ReadabilityExtractor(),
    ethicsGate: askEthicsGate,
    synthesizer: new DeterministicSynthesizer(),
    queryGen: new FollowUpQueryGenerator(),
    logger,
  });
}

function runtimeWithDefaults(runtime?: Partial<ResearchRuntime>): ResearchRuntime {
  return {
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    createLoop: runtime?.createLoop ?? createDefaultResearchLoop,
    runTask: runtime?.runTask ?? runAgenticTask,
    isTty: runtime?.isTty ?? process.stdin.isTTY === true,
  };
}

async function runAgenticResearch(
  topic: string,
  invocation: ResearchInvocation,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: ResearchCommandOptions,
  runtime: ResearchRuntime,
  explicitWallClockMs: number | null,
): Promise<void> {
  const stdout = runtime.stdout as NodeJS.WriteStream;
  const renderOpts: ConnectorRenderOpts = {
    json: format === 'json',
    debug: false,
    noColor: resolveNoColor(options, runtime),
    stream: runtime.stdout,
    errStream: runtime.stderr,
    briefDetail: detail,
    briefFormat: format,
    ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
  };
  const connector = new CLIConnectorIO(
    format === 'json' ? new JSONRenderer() : new TerminalRenderer(),
    {
      renderOpts,
      interactive: runtime.isTty && format !== 'json',
      suppressPublishedOutcome: true,
    },
  );
  const profile = resolveCommandTaskProfile('research', runtime.env);
  const outcome = await runtime.runTask({
    goal: topic,
    model: selectAgentModel(runtime.env),
    auth: { mode: 'managed' },
    profile,
    budgets: {
      ...(explicitWallClockMs === null ? {} : { wallClockMs: explicitWallClockMs }),
      totalToolCalls: invocation.options.budget.maxLlmCalls,
    },
    connector,
  });
  if (outcome.kind !== 'published') {
    throw new Error(agentFailureMessage(outcome));
  }
  const parsed = validateBrief(
    JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown,
  );
  if (!parsed.isOk) throw new Error('The agent published an invalid Brief artifact.');
  renderBrief(
    runtime,
    { brief: parsed.value, artifacts: null, hops: [], terminationReason: 'coverage_met' },
    {
      format,
      detail,
      options,
    },
  );
  if (options.open === true) openArtifact(outcome.brief.htmlPath);
}

function agentFailureMessage(
  outcome: Exclude<AgenticTaskOutcome, { readonly kind: 'published' }>,
): string {
  return outcome.kind === 'handoff'
    ? `${outcome.blocker}: ${outcome.safestNextAction}`
    : `${outcome.error.code}: ${outcome.error.message}`;
}

function selectAgentModel(env: NodeJS.ProcessEnv): AgenticTaskRequest['model'] {
  return {
    provider: (env.YANTRA_AGENT_PROVIDER ?? 'anthropic').trim(),
    id: (env.YANTRA_AGENT_MODEL ?? 'claude-haiku-4-5').trim(),
  };
}

function buildInvocation(
  topic: string,
  options: ResearchCommandOptions,
  env: NodeJS.ProcessEnv,
): ResearchInvocation {
  const maxHops = clampInt(options.depth, 2, 1, 3);
  const maxSources = clampInt(options.maxSources, 24, 1, 100);
  const maxWallClockMs = clampInt(options.budgetMs, 180_000, 1_000, 600_000);
  const maxLlmCalls = clampInt(options.budget, 12, 1, 100);
  const noLlm = options.llm === false || env.LLM_PROVIDER === 'none';

  return {
    searchProvider: parseProvider(options.searchProvider),
    options: {
      topic,
      budget: { maxHops, maxSources, maxWallClockMs, maxLlmCalls },
      noLlm,
      length: parseLength(options.length),
      scope: 'public',
      perQueryLimit: clampInt(options.perQueryLimit, 6, 1, 10),
      perFetchTimeoutMs: clampInt(options.fetchTimeout, 8_000, 1_000, 120_000),
      coverageTarget: 0.9,
    },
  };
}

/** `--json` is a shorthand for `--format json`; otherwise honor `--format`. */
function resolveFormat(options: ResearchCommandOptions): BriefOutputFormat {
  if (options.json === true) {
    return 'json';
  }
  const format = options.format ?? 'terminal';
  return format === 'md' || format === 'html' || format === 'json' ? format : 'terminal';
}

function resolveNoColor(options: ResearchCommandOptions, runtime: ResearchRuntime): boolean {
  if (options.color === false) {
    return true;
  }
  if (runtime.env.NO_COLOR !== undefined && runtime.env.NO_COLOR !== '') {
    return true;
  }
  return (runtime.stdout as NodeJS.WriteStream).isTTY !== true;
}

function parseLength(raw: string | undefined): SynthesisLength {
  return raw === 'short' || raw === 'medium' ? raw : 'long';
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseProvider(raw: string | undefined): SearchProviderName | null {
  if (!raw || raw === 'auto') {
    return null;
  }
  if (raw === 'google' || raw === 'duckduckgo' || raw === 'brave' || raw === 'tavily') {
    return raw;
  }
  return null;
}
