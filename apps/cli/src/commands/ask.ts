import { readFile } from 'node:fs/promises';

import {
  exitCodeForAgenticOutcome,
  resolveCommandTaskProfile,
  type runAgenticTask,
  type ActiveReportTemplate,
  type AgenticTaskOutcome,
} from '@yantra/agent';
import {
  AskPipeline,
  BlocklistImpl,
  BrowserFallbackFetcher,
  DeterministicSynthesizer,
  EthicsGateImpl,
  FileSystemAskCache,
  HttpFetcher,
  HybridContentFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  RobotsCacheImpl,
  buildPersonalizationContext,
  createAskEthicsAdapter,
  createKeychainProvider,
  loadEthicsConfig,
  loadSearchConfig,
  preferenceValue,
  resolveSearchProvider,
  type AskQuery,
  type AskRunResult,
  type EffectivePreferences,
  type Logger,
  type Sanitized,
  type SearchProviderName,
  type SynthesisLength,
  UserInputMarkerError,
} from '@yantra/core';
import { validateBrief, validateTemplatedReport, type TemplatedReport } from '@yantra/protocol';
import { CommanderError, Option, type Command } from 'commander';

import {
  addAgentOptions,
  parseDuration,
  resolveAgentInvocation,
  type AgentInvocation,
  type AgentOptions,
} from '../agent-options.js';
import { CLIConnectorIO } from '../connector-io.js';
import { recordTaskHistory } from '../history.js';
import { openArtifact } from '../open-artifact.js';
import {
  loadEffectivePreferences,
  resolveAmbientContext,
  type ResolvedAmbientContext,
} from '../preferences.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { BriefDetailLevel, BriefOutputFormat, ConnectorRenderOpts } from '../render/types.js';
import { createBestEffortRankSignalSink, runAgenticTaskWithRankSink } from '../runtime.js';
import {
  TEMPLATE_LLM_GUARD,
  TEMPLATE_OPTION_DESCRIPTION,
  resolveTemplateRef,
} from '../template-ref.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface AskOptions extends AgentOptions {
  readonly json?: boolean;
  readonly llm?: boolean;
  readonly cache?: boolean;
  readonly color?: boolean;
  readonly open?: boolean;
  readonly maxSources?: string;
  readonly searchProvider?: string;
  readonly limit?: string;
  readonly detail?: string;
  readonly format?: string;
  readonly length?: string;
  readonly fetchTimeout?: string;
  readonly pipelineTimeout?: string;
  readonly template?: string;
}

export interface AskRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly createPipeline: (query: AskQuery) => Promise<AskPipeline>;
  /** Resolves the merged effective preferences used for flag defaults. */
  readonly resolveDefaults: () => Promise<EffectivePreferences>;
  /** Records a completed task into the history index (best-effort). */
  readonly recordHistory: (runId: string) => Promise<void>;
  /** Shared agentic runtime; only selected after deterministic mode is ruled out. */
  readonly runTask: typeof runAgenticTask;
  /** Shared option resolver; injectable so command tests never inspect host credentials. */
  readonly resolveAgent: typeof resolveAgentInvocation;
  readonly isTty: boolean;
  readonly resolveTemplate: (ref: string) => Promise<ActiveReportTemplate>;
}

/**
 * Registers the `ask` subcommand: `Search → Fetch → Extract → Synthesize →
 * Render`, producing a Brief (styled terminal / md / html / json).
 */
export function registerAskCommand(program: Command, runtime?: Partial<AskRuntime>): void {
  const resolvedRuntime = runtimeWithDefaults(runtime);

  const askCommand = program
    .command('ask')
    .description('Answer a question from the web as a synthesized Brief.')
    .argument('<query>', 'question to answer from web sources');
  // Shared agent model-selection surface (`--provider`/`--model`/`--thinking`/
  // `--auth-secret`), identical to `research` and `do`. These bind the LLM
  // provider; `--search-provider` below is the unrelated web-search backend.
  addAgentOptions(askCommand)
    .addOption(new Option('--json', 'shorthand for --format json').default(false))
    .addOption(
      new Option(
        '--detail <level>',
        'terminal disclosure level (default: prefs.defaults.detail)',
      ).choices(['overview', 'standard', 'full']),
    )
    .addOption(
      new Option('--format <format>', 'output format sent to stdout')
        .choices(['terminal', 'md', 'html', 'json'])
        .default('terminal'),
    )
    .addOption(
      new Option(
        '--length <length>',
        'synthesis length budget (default: prefs.defaults.length)',
      ).choices(['short', 'medium', 'long']),
    )
    .addOption(new Option('--open', 'open the generated brief.html in the default browser'))
    .addOption(new Option('--template <name|tag|path>', TEMPLATE_OPTION_DESCRIPTION))
    .addOption(new Option('--no-cache', 'disable cache reads/writes'))
    .addOption(new Option('--no-color', 'disable ANSI color output'))
    .addOption(new Option('--max-sources <n>', 'maximum sources to fetch'))
    .addOption(
      new Option(
        '--search-provider <provider>',
        'search provider (default: auto walks tavily -> brave -> duckduckgo); ' +
          'tavily/brave require API keys, google/duckduckgo scrape (google is opt-in)',
      ).choices(['auto', 'google', 'duckduckgo', 'brave', 'tavily']),
    )
    .addOption(new Option('--limit <count>', 'number of sources to consider').default('3'))
    .addOption(new Option('--fetch-timeout <ms>', 'per-fetch timeout in ms').default('30000'))
    .addOption(
      new Option(
        '--pipeline-timeout <duration>',
        'deterministic pipeline timeout (for example 100s)',
      ).default('100s'),
    )
    .action(async (queryArg: string, options: AskOptions, command: Command) => {
      // Resolve unset flags from the effective preferences (explicit flag wins).
      const effective = await resolvedRuntime.resolveDefaults();
      const resolved = resolveAskDefaults(options, effective);
      const agent = await resolvedRuntime.resolveAgent(
        'ask',
        options,
        resolvedRuntime.env,
        effective,
      );
      if (agent.mode === 'no-llm' && agent.reason === 'unavailable') {
        resolvedRuntime.stderr.write(
          `warning: model ${agent.model.provider}/${agent.model.id} is unavailable because no credential resolved; ` +
            'configure provider auth or pass --auth-secret <ref>; using deterministic research\n',
        );
      }
      const baseQuery = buildAskQuery(queryArg, options, resolved, agent.mode === 'no-llm');
      // Build the privacy-gated personalization context (LLM path only). The
      // builder takes preferences only — raw history has no path in.
      const personalization = baseQuery.noLlm ? null : personalizationFrom(effective);
      const query: AskQuery = personalization ? { ...baseQuery, personalization } : baseQuery;
      const format = resolveFormat(options);
      const detail = resolved.detail;
      if (options.template !== undefined && query.noLlm) {
        resolvedRuntime.stderr.write(`${TEMPLATE_LLM_GUARD}\n`);
        throw new CommanderError(1, 'yantra.template.llm-required', TEMPLATE_LLM_GUARD);
      }
      const template =
        options.template === undefined
          ? undefined
          : await resolvedRuntime.resolveTemplate(options.template).catch((error: unknown) => {
              resolvedRuntime.stderr.write(
                `${error instanceof Error ? error.message : String(error)}\n`,
              );
              throw error;
            });
      if (
        template !== undefined &&
        (command.getOptionValueSource('detail') === 'cli' ||
          command.getOptionValueSource('length') === 'cli')
      ) {
        resolvedRuntime.stderr.write(
          'warning: --detail and --length do not affect template-defined report structure\n',
        );
      }

      // Resolved before the try so a bad --provider/--model is a validation
      // failure (exit 1) rather than being reclassified as an execution failure
      // by the catch below. Skipped entirely in deterministic mode, which never
      // constructs a provider session.
      resolvedRuntime.stderr.write(
        `ask: search-provider=${query.searchProvider ?? 'auto'} limit=${query.limit} ` +
          `no-llm=${query.noLlm} detail=${detail} format=${format}` +
          (agent.mode === 'no-llm' ? '' : ` model=${agent.model.provider}/${agent.model.id}`) +
          '\n',
      );

      try {
        // Selection happens before the agent runtime/provider is constructed.
        // The deterministic pipeline below is deliberately untouched.
        if (agent.mode === 'llm') {
          await runAgenticAsk(
            queryArg,
            query,
            format,
            detail,
            options,
            resolvedRuntime,
            template,
            agent,
            resolveAmbientContext(effective),
          );
          return;
        }
        const pipeline = await resolvedRuntime.createPipeline(query);
        const result: AskRunResult = await pipeline.run(query);

        renderBrief(resolvedRuntime, result, { format, detail, options });

        // Record the completed task into the history index (best-effort — a
        // missing/failed index never fails the ask). Reads the manifest the
        // pipeline just wrote under runs/<run_id>/.
        const runId = result.brief.metadata.run_id;
        if (typeof runId === 'string' && runId.length > 0) {
          await resolvedRuntime.recordHistory(runId);
        }

        if (options.open === true && result.artifacts !== null) {
          openArtifact(result.artifacts.htmlPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof UserInputMarkerError) {
          resolvedRuntime.stderr.write(`ask validation failed: ${message}\n`);
          throw new CommanderError(1, 'yantra.ask.invalid-user-input-marker', message);
        }
        resolvedRuntime.stderr.write(`ask failed: ${message}\n`);
        throw new CommanderError(2, 'yantra.ask.failed', message);
      }
    });
}

/** Renders the Brief through the unified connector dispatch. */
function renderBrief(
  runtime: AskRuntime,
  result: AskRunResult,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: AskOptions },
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
    suppressOpenHint: view.options.open === true,
    ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
  };

  io.renderResult({ kind: 'brief', brief: result.brief, artifacts: result.artifacts }, opts);
}

function renderTemplated(
  runtime: AskRuntime,
  report: TemplatedReport,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: AskOptions },
  artifacts: { jsonPath: string; markdownPath: string; htmlPath: string },
): void {
  const renderer = view.format === 'json' ? new JSONRenderer() : new TerminalRenderer();
  const io = new CLIConnectorIO(renderer);
  const stdout = runtime.stdout as NodeJS.WriteStream;
  io.renderResult(
    {
      kind: 'templated_report',
      report,
      artifacts: {
        jsonPath: artifacts.jsonPath,
        mdPath: artifacts.markdownPath,
        htmlPath: artifacts.htmlPath,
      },
    },
    {
      json: view.format === 'json',
      debug: false,
      noColor: resolveNoColor(view.options, runtime),
      stream: runtime.stdout,
      errStream: runtime.stderr,
      briefDetail: view.detail,
      briefFormat: view.format,
      ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
    },
  );
}

/**
 * Constructs the default ask pipeline used by the CLI. The synthesizer is the
 * deterministic strategy today; LLM synthesis is wired when the configurable
 * provider registry (FEAT-016) lands, at which point `selectSynthesizer` picks
 * between the two.
 */
export async function createDefaultAskPipeline(query: AskQuery): Promise<AskPipeline> {
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
    taskId: 'ask',
    runId: 'ask',
    stepId: 'ask',
    action: 'fetch',
  });

  const keychain = await createKeychainProvider();
  const searchConfig = await loadSearchConfig();
  const resolved = await resolveSearchProvider({
    explicitProvider: query.searchProvider,
    env: process.env,
    config: searchConfig,
    deps: { keychain, browserProvider, ethicsGate: askEthicsGate, logger },
  });
  if (!resolved.isOk) {
    // Explicit-selection key-missing / exhausted-chain failures carry an
    // actionable hint; surface the message verbatim.
    throw resolved.error;
  }
  const searchProvider = resolved.value;

  const fetcher = new HybridContentFetcher({
    httpFetcher: new HttpFetcher(),
    browserFetcher: new BrowserFallbackFetcher({ browserProvider }),
  });
  const rankSink = await createBestEffortRankSignalSink(logger);

  return new AskPipeline({
    searchProvider,
    fetcher,
    extractor: new ReadabilityExtractor(),
    cache: new FileSystemAskCache(),
    ethicsGate: askEthicsGate,
    logger,
    synthesizer: new DeterministicSynthesizer(),
    ...(rankSink === null ? {} : { rankSink }),
  });
}

function runtimeWithDefaults(runtime?: Partial<AskRuntime>): AskRuntime {
  return {
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    createPipeline: runtime?.createPipeline ?? createDefaultAskPipeline,
    resolveDefaults: runtime?.resolveDefaults ?? (() => loadEffectivePreferences()),
    recordHistory: runtime?.recordHistory ?? ((runId: string) => recordTaskHistory(runId)),
    runTask: runtime?.runTask ?? runAgenticTaskWithRankSink,
    resolveAgent: runtime?.resolveAgent ?? resolveAgentInvocation,
    isTty: runtime?.isTty ?? process.stdin.isTTY === true,
    resolveTemplate:
      runtime?.resolveTemplate ??
      ((ref) => resolveTemplateRef(ref, { isTty: runtime?.isTty ?? process.stdin.isTTY === true })),
  };
}

async function runAgenticAsk(
  question: string,
  query: AskQuery,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
  runtime: AskRuntime,
  template: ActiveReportTemplate | undefined,
  agent: Extract<AgentInvocation, { readonly mode: 'llm' }>,
  ambient: ResolvedAmbientContext,
): Promise<void> {
  const renderOpts = agentRenderOpts(runtime, format, detail, options);
  const connector = new CLIConnectorIO(
    format === 'json' ? new JSONRenderer() : new TerminalRenderer(),
    {
      renderOpts,
      interactive: runtime.isTty && format !== 'json',
      suppressPublishedOutcome: true,
    },
  );
  const profile = resolveCommandTaskProfile('ask', runtime.env);
  const outcome = await runtime.runTask({
    goal: question,
    model: agent.model,
    auth: agent.auth,
    profile,
    budgets: agent.budgets,
    ...(query.personalization ? { profileContext: query.personalization } : {}),
    ...(template === undefined ? {} : { template }),
    ambient,
    screenshotsSuppressed: options.screenshots === false,
    connector,
  });
  await renderAgenticOutcome(outcome, runtime, format, detail, options);
}

function agentRenderOpts(
  runtime: AskRuntime,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
): ConnectorRenderOpts {
  const stdout = runtime.stdout as NodeJS.WriteStream;
  return {
    json: format === 'json',
    debug: false,
    noColor: resolveNoColor(options, runtime),
    stream: runtime.stdout,
    errStream: runtime.stderr,
    briefDetail: detail,
    briefFormat: format,
    suppressOpenHint: options.open === true,
    ...(typeof stdout.columns === 'number' ? { width: stdout.columns } : {}),
  };
}

async function renderAgenticOutcome(
  outcome: AgenticTaskOutcome,
  runtime: AskRuntime,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
): Promise<void> {
  if (outcome.kind !== 'published') {
    throw new Error(agentFailureMessage(outcome));
  }
  const raw = JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown;
  if (outcome.brief.kind === 'templated_report') {
    const parsed = validateTemplatedReport(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid templated report artifact.');
    renderTemplated(runtime, parsed.value, { format, detail, options }, outcome.brief);
  } else {
    const parsed = validateBrief(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid Brief artifact.');
    renderBrief(runtime, { brief: parsed.value, artifacts: null }, { format, detail, options });
  }
  await runtime.recordHistory(outcome.runId);
  if (options.open === true) openArtifact(outcome.brief.htmlPath);
  const exitCode = exitCodeForAgenticOutcome(outcome);
  if (exitCode !== 0) throw new Error(`Agentic ask exited with ${exitCode}.`);
}

function agentFailureMessage(
  outcome: Exclude<AgenticTaskOutcome, { readonly kind: 'published' }>,
): string {
  return outcome.kind === 'handoff'
    ? `${outcome.blocker}: ${outcome.safestNextAction}`
    : `${outcome.error.code}: ${outcome.error.message}`;
}

/** Resolved presentation/synthesis defaults (explicit flag > prefs > hardcoded). */
export interface ResolvedAskDefaults {
  readonly detail: BriefDetailLevel;
  readonly length: SynthesisLength;
  readonly provider: SearchProviderName | null;
}

/**
 * Applies the flag-default resolution matrix: an explicit CLI flag always wins;
 * otherwise the effective preference value is used; otherwise a hardcoded
 * fallback. `defaults.search_provider = auto` resolves to `null` (the pipeline's
 * "walk the fallback chain" sentinel).
 */
export function resolveAskDefaults(
  options: AskOptions,
  effective: EffectivePreferences,
): ResolvedAskDefaults {
  const detail =
    asDetail(options.detail) ??
    preferenceValue<BriefDetailLevel>(effective, 'defaults.detail', 'standard');
  const length =
    asLength(options.length) ??
    preferenceValue<SynthesisLength>(effective, 'defaults.length', 'medium');

  const explicitProvider = parseProvider(options.searchProvider);
  const prefProvider = preferenceValue<string>(effective, 'defaults.search_provider', 'auto');
  const provider =
    explicitProvider ?? (prefProvider === 'auto' ? null : parseProvider(prefProvider));

  return { detail, length, provider };
}

/**
 * Builds the sanitized personalization context from the effective preferences,
 * or null when personalization is disabled / empty / errors. Never throws —
 * personalization is a nicety, not a requirement for `ask`.
 */
function personalizationFrom(effective: EffectivePreferences): Sanitized<string> | null {
  const result = buildPersonalizationContext(effective);
  return result.isOk ? result.value : null;
}

function asDetail(raw: string | undefined): BriefDetailLevel | undefined {
  return raw === 'overview' || raw === 'standard' || raw === 'full' ? raw : undefined;
}

function asLength(raw: string | undefined): SynthesisLength | undefined {
  return raw === 'short' || raw === 'medium' || raw === 'long' ? raw : undefined;
}

function buildAskQuery(
  raw: string,
  options: AskOptions,
  resolved: ResolvedAskDefaults,
  noLlm: boolean,
): AskQuery {
  const limit = clampInt(options.limit, 3, 1, 10);
  const budgetCalls = parseNullablePositiveInt(options.maxSources);

  return {
    raw,
    normalized: raw.trim().replace(/\s+/g, ' ').toLowerCase(),
    limit,
    noCache: options.cache === false,
    noLlm,
    budgetCalls,
    searchProvider: resolved.provider,
    perFetchTimeoutMs: clampInt(options.fetchTimeout, 8_000, 1_000, 120_000),
    pipelineBudgetMs: noLlm
      ? Math.min(
          300_000,
          Math.max(1_000, parseDuration(options.pipelineTimeout ?? '100s', '--pipeline-timeout')),
        )
      : 100_000,
    length: resolved.length,
  };
}

/** `--json` is a shorthand for `--format json`; otherwise honor `--format`. */
function resolveFormat(options: AskOptions): BriefOutputFormat {
  if (options.json === true) {
    return 'json';
  }
  const format = options.format ?? 'terminal';
  return format === 'md' || format === 'html' || format === 'json' ? format : 'terminal';
}

function resolveNoColor(options: AskOptions, runtime: AskRuntime): boolean {
  if (options.color === false) {
    return true;
  }
  if (runtime.env.NO_COLOR !== undefined && runtime.env.NO_COLOR !== '') {
    return true;
  }
  return (runtime.stdout as NodeJS.WriteStream).isTTY !== true;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseNullablePositiveInt(raw: string | undefined): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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
