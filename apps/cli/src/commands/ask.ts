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
  createSelectedBrowserProvider,
  type BrowserRuntimeOptions,
  type BrowserSelection,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  RobotsCacheImpl,
  buildPersonalizationContext,
  createAskEthicsAdapter,
  createKeychainProvider,
  launchPerUsePageSource,
  loadEthicsConfig,
  loadSearchConfig,
  preferenceValue,
  resolveSearchProvider,
  type AskQuery,
  type AskRunResult,
  type ExecutionReceiptDraft,
  type EffectivePreferences,
  type Logger,
  type Sanitized,
  type SearchProviderName,
  type SynthesisLength,
  ResourceBusyError,
  RunEventLogError,
  UserInputMarkerError,
  type RunEventStream,
} from '@yantra/core';
import {
  COMMAND_REGISTRY,
  validateBrief,
  validateTemplatedReport,
  type TemplatedReport,
} from '@yantra/protocol';
import { CommanderError, type Command } from 'commander';

import {
  createTerminalContext,
  type TerminalOptions,
} from '../adapters/terminal/terminal-adapter.js';
import {
  parseDuration,
  resolveAgentInvocation,
  type AgentInvocation,
  type AgentOptions,
} from '../agent-options.js';
import {
  resolveBrowserSelectionOverride,
  type BrowserSelectionOptions,
} from '../browser-options.js';
import { agentFailureLine } from '../connector-io.js';
import type { CommandContext } from '../context/command-context.js';
import { resourceOptions } from '../context/resource-options.js';
import { draftRunReceipt } from '../context/run-receipt.js';
import { recordTaskHistory } from '../history.js';
import { resolveAmbientContext, type ResolvedAmbientContext } from '../preferences.js';
import { attachRegistered } from '../registry/build-command-tree.js';
import { handler, type Handler, type HandlerArgs } from '../registry/handler.js';
import { goalEchoEvent } from '../render/goal-echo.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { BriefDetailLevel, BriefOutputFormat, ConnectorRenderOpts } from '../render/types.js';
import {
  createLiveRunEvents,
  exitCodeOfThrown,
  finishRunEvents,
  warningEvent,
} from '../run-event-output.js';
import { createBestEffortRankSignalSink, runAgenticTaskWithRankSink } from '../runtime.js';
import { TEMPLATE_LLM_GUARD, resolveTemplateRef } from '../template-ref.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface AskOptions extends AgentOptions, BrowserSelectionOptions {
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
  readonly createPipeline: (
    query: AskQuery,
    browser?: BrowserRuntimeOptions,
  ) => Promise<AskPipeline>;
  /** Resolves the merged effective preferences used for flag defaults. */
  readonly resolveDefaults: () => Promise<EffectivePreferences>;
  /** Records a completed task into the history index (best-effort). */
  readonly recordHistory: (runId: string) => Promise<void>;
  /** Shared agentic runtime; only selected after deterministic mode is ruled out. */
  readonly runTask: typeof runAgenticTask;
  /** Shared option resolver; injectable so command tests never inspect host credentials. */
  readonly resolveAgent: typeof resolveAgentInvocation;
  readonly resolveTemplate: (ref: string) => Promise<ActiveReportTemplate>;
}

/**
 * Registers the `ask` subcommand: `Search → Fetch → Extract → Synthesize →
 * Render`, producing a Brief (styled terminal / md / html / json).
 */
export function registerAskCommand(
  program: Command,
  runtime?: Partial<AskRuntime> & TerminalOptions,
  context?: CommandContext,
): void {
  attachRegistered(program, 'ask', { ask: makeAskHandler(runtime, context) });
}

/** The `ask` handler over an injectable runtime, bound to the `ask` registry entry. */
export function makeAskHandler(
  runtime?: Partial<AskRuntime> & TerminalOptions,
  context: CommandContext = createTerminalContext(runtime),
): Handler {
  const resolvedRuntime = runtimeWithDefaults(context, runtime);
  let honorsAbort = false;
  const bound = handler(
    async (args: HandlerArgs, options: AskOptions, command: Command): Promise<void> => {
      const [queryArg] = args as readonly [string];
      const entry = COMMAND_REGISTRY.commands.find((e) => e.id === 'ask');
      if (entry?.kind === 'leaf') context.settings.bind(entry, command);

      // A conflicting `--browser` pair is a validation failure, resolved before
      // any pipeline or provider session exists.
      const browserSelection = resolveBrowserSelectionOverride(options);
      // Resolve unset flags from the effective preferences (explicit flag wins).
      const effective = await resolvedRuntime.resolveDefaults();
      context.settings.usePreferences(effective);
      const resolved = resolveAskDefaults(options, effective);
      const format = resolveFormat(options);
      const detail = resolved.detail;
      // FEAT-063: the run's event stream, created before the run exists so the
      // goal echo and advisories print first. Every live line goes through it.
      const runEvents = createLiveRunEvents(agentRenderOpts(context, format, detail, options));
      try {
        await askWithRunEvents();
      } catch (error) {
        finishRunEvents(runEvents, exitCodeOfThrown(error));
        throw error;
      }
      finishRunEvents(runEvents, 0);

      async function askWithRunEvents(): Promise<void> {
        const agent = await resolvedRuntime.resolveAgent(
          'ask',
          options,
          context.settings.env(),
          effective,
        );
        honorsAbort = agent.mode === 'llm';
        if (agent.mode === 'no-llm' && agent.reason === 'unavailable') {
          runEvents.emit(
            warningEvent(
              'command',
              `model ${agent.model.provider}/${agent.model.id} is unavailable because no credential resolved; ` +
                'configure provider auth or pass --auth-secret <ref>; using deterministic research',
            ),
          );
        }
        const baseQuery = buildAskQuery(queryArg, options, resolved, agent.mode === 'no-llm');
        // Build the privacy-gated personalization context (LLM path only). The
        // builder takes preferences only — raw history has no path in.
        const personalization = baseQuery.noLlm ? null : personalizationFrom(effective);
        const query: AskQuery = personalization ? { ...baseQuery, personalization } : baseQuery;
        if (options.template !== undefined && query.noLlm) {
          context.output.stderr.write(`${TEMPLATE_LLM_GUARD}\n`);
          throw new CommanderError(1, 'yantra.template.llm-required', TEMPLATE_LLM_GUARD);
        }
        const template =
          options.template === undefined
            ? undefined
            : await resolvedRuntime.resolveTemplate(options.template).catch((error: unknown) => {
                context.output.stderr.write(
                  `${error instanceof Error ? error.message : String(error)}\n`,
                );
                throw error;
              });
        if (
          template !== undefined &&
          (command.getOptionValueSource('detail') === 'cli' ||
            command.getOptionValueSource('length') === 'cli')
        ) {
          runEvents.emit(
            warningEvent(
              'command',
              '--detail and --length do not affect template-defined report structure',
            ),
          );
        }

        const receipt = await draftRunReceipt(context, ['ask'], {
          agent,
          ...(template === undefined ? {} : { template }),
          ...(browserSelection === undefined ? {} : { browser: browserSelection }),
          settings: {
            llm: !query.noLlm,
            detail,
            length: query.length,
            format,
            limit: query.limit,
            searchProvider: query.searchProvider,
            fetchTimeout: query.perFetchTimeoutMs,
            pipelineTimeout: query.pipelineBudgetMs,
          },
        });
        // Resolved before the try so a bad --provider/--model is a validation
        // failure (exit 1) rather than being reclassified as an execution failure
        // by the catch below. Skipped entirely in deterministic mode, which never
        // constructs a provider session.
        context.output.stderr.write(
          `ask: search-provider=${query.searchProvider ?? 'auto'} limit=${query.limit} ` +
            `no-llm=${query.noLlm} detail=${detail} format=${format}` +
            (agent.mode === 'no-llm' ? '' : ` model=${agent.model.provider}/${agent.model.id}`) +
            '\n',
        );
        // The goal exactly as received, so a shell-rewritten argument is visible.
        runEvents.emit(goalEchoEvent(queryArg));

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
              context,
              template,
              agent,
              resolveAmbientContext(effective),
              browserSelection,
              receipt,
              runEvents,
            );
            return;
          }
          const pipeline = await resolvedRuntime.createPipeline(query, {
            resourceLockOptions: resourceOptions(context, 'ask'),
            installOfferGateway: context.gateways.installOffer(
              context.isInteractive({ json: format === 'json' }),
            ),
            ...(browserSelection === undefined ? {} : { selection: browserSelection }),
          });
          const result: AskRunResult = await pipeline.run({ ...query, receipt, runEvents });

          renderBrief(context, result, { format, detail, options });

          // Record the completed task into the history index (best-effort — a
          // missing/failed index never fails the ask). Reads the manifest the
          // pipeline just wrote under runs/<run_id>/.
          const runId = result.brief.metadata.run_id;
          if (typeof runId === 'string' && runId.length > 0) {
            await resolvedRuntime.recordHistory(runId);
          }

          if (options.open === true && result.artifacts !== null) {
            context.openExternal(result.artifacts.htmlPath);
          }
        } catch (error) {
          if (error instanceof ResourceBusyError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof UserInputMarkerError) {
            context.output.stderr.write(`ask validation failed: ${message}\n`);
            throw new CommanderError(1, 'yantra.ask.invalid-user-input-marker', message);
          }
          context.output.stderr.write(`ask failed: ${message}\n`);
          if (error instanceof CommanderError) throw error;
          // An unopenable run-event log is an environment failure (exit 3).
          if (error instanceof RunEventLogError)
            throw new CommanderError(3, 'yantra.ask.run-events-unavailable', message);
          throw new CommanderError(2, 'yantra.ask.failed', message);
        }
      }
    },
  );
  return Object.defineProperty(bound, 'honorsAbort', { get: () => honorsAbort });
}

/** Renders the Brief through the unified connector dispatch. */
function renderBrief(
  context: CommandContext,
  result: AskRunResult,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: AskOptions },
): void {
  const renderer = view.format === 'json' ? new JSONRenderer() : new TerminalRenderer();
  const io = context.connector(renderer);

  const opts: ConnectorRenderOpts = {
    json: view.format === 'json',
    debug: false,
    noColor: resolveNoColor(view.options, context),
    stream: context.output.stdout,
    errStream: context.output.stderr,
    briefDetail: view.detail,
    briefFormat: view.format,
    suppressOpenHint: view.options.open === true,
    ...(context.output.columns === null ? {} : { width: context.output.columns }),
  };

  io.renderResult({ kind: 'brief', brief: result.brief, artifacts: result.artifacts }, opts);
}

function renderTemplated(
  context: CommandContext,
  report: TemplatedReport,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: AskOptions },
  artifacts: { jsonPath: string; markdownPath: string; htmlPath: string },
): void {
  const renderer = view.format === 'json' ? new JSONRenderer() : new TerminalRenderer();
  const io = context.connector(renderer);
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
      noColor: resolveNoColor(view.options, context),
      stream: context.output.stdout,
      errStream: context.output.stderr,
      briefDetail: view.detail,
      briefFormat: view.format,
      ...(context.output.columns === null ? {} : { width: context.output.columns }),
    },
  );
}

/**
 * Constructs the default ask pipeline used by the CLI. The synthesizer is the
 * deterministic strategy today; LLM synthesis is wired when the configurable
 * provider registry (FEAT-016) lands, at which point `selectSynthesizer` picks
 * between the two.
 */
export async function createDefaultAskPipeline(
  query: AskQuery,
  browser: BrowserRuntimeOptions = {},
  env: Readonly<NodeJS.ProcessEnv> = {},
): Promise<AskPipeline> {
  const logger = noopLogger;

  const profileStore = new LocalProfileStore({
    logger,
    leaseOptions: browser.resourceLockOptions ?? {},
  });
  // The same seam every other launch-capable path uses; building it starts no
  // browser, so the lazy fetch fallback stays lazy.
  const browserProvider = createSelectedBrowserProvider({ ...browser, profileStore, logger });
  // One browser launch per SERP scrape or fetch fallback, as before FEAT-050:
  // the deterministic loop keeps its own wiring and gains only the honest
  // timeout the page source enforces.
  const pages = launchPerUsePageSource(browserProvider);

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
    env,
    config: searchConfig,
    deps: { keychain, pages, ethicsGate: askEthicsGate, logger },
  });
  if (!resolved.isOk) {
    // Explicit-selection key-missing / exhausted-chain failures carry an
    // actionable hint; surface the message verbatim.
    throw resolved.error;
  }
  const searchProvider = resolved.value;

  const fetcher = new HybridContentFetcher({
    httpFetcher: new HttpFetcher(),
    browserFetcher: new BrowserFallbackFetcher({ pages }),
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

function runtimeWithDefaults(context: CommandContext, runtime?: Partial<AskRuntime>): AskRuntime {
  return {
    createPipeline:
      runtime?.createPipeline ??
      ((query, browser) => createDefaultAskPipeline(query, browser, context.settings.env())),
    resolveDefaults: runtime?.resolveDefaults ?? (() => context.settings.preferences()),
    recordHistory: runtime?.recordHistory ?? recordTaskHistory,
    runTask: runtime?.runTask ?? runAgenticTaskWithRankSink,
    resolveAgent: runtime?.resolveAgent ?? resolveAgentInvocation,
    resolveTemplate:
      runtime?.resolveTemplate ??
      ((ref) =>
        resolveTemplateRef(ref, {
          cwd: context.cwd,
          isTty: context.isInteractive({}),
          choose: (names) => context.input.choose(names),
        })),
  };
}

async function runAgenticAsk(
  question: string,
  query: AskQuery,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
  runtime: AskRuntime,
  context: CommandContext,
  template: ActiveReportTemplate | undefined,
  agent: Extract<AgentInvocation, { readonly mode: 'llm' }>,
  ambient: ResolvedAmbientContext,
  browserSelection: BrowserSelection | undefined,
  receipt: ExecutionReceiptDraft,
  runEvents: RunEventStream,
): Promise<void> {
  const renderOpts = agentRenderOpts(context, format, detail, options);
  const connector = context.connector(
    format === 'json' ? new JSONRenderer() : new TerminalRenderer(),
    {
      renderOpts,
      interactive: context.isInteractive({ json: format === 'json' }),
      suppressPublishedOutcome: true,
      runEvents,
    },
  );
  const profile = resolveCommandTaskProfile('ask');
  const outcome = await runtime.runTask(
    {
      goal: question,
      receipt,
      signal: context.signal,
      model: agent.model,
      ...(agent.thinkingSource === undefined ? {} : { thinkingSource: agent.thinkingSource }),
      auth: agent.auth,
      profile,
      budgets: agent.budgets,
      ...(query.personalization ? { profileContext: query.personalization } : {}),
      ...(template === undefined ? {} : { template }),
      ambient,
      screenshotsSuppressed: options.screenshots === false,
      connector,
      runEvents,
    },
    {
      cwd: context.cwd,
      browserInstallOfferGateway: context.gateways.installOffer(
        context.isInteractive({ json: format === 'json' }),
      ),
      ...(browserSelection === undefined ? {} : { browserSelection }),
    },
  );
  await renderAgenticOutcome(outcome, runtime, context, format, detail, options);
}

function agentRenderOpts(
  context: CommandContext,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
): ConnectorRenderOpts {
  return {
    json: format === 'json',
    debug: false,
    noColor: resolveNoColor(options, context),
    stream: context.output.stdout,
    errStream: context.output.stderr,
    briefDetail: detail,
    briefFormat: format,
    suppressOpenHint: options.open === true,
    ...(context.output.columns === null ? {} : { width: context.output.columns }),
  };
}

async function renderAgenticOutcome(
  outcome: AgenticTaskOutcome,
  runtime: AskRuntime,
  context: CommandContext,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: AskOptions,
): Promise<void> {
  if (outcome.kind !== 'published') {
    throw new CommanderError(
      exitCodeForAgenticOutcome(outcome),
      'yantra.ask.' + outcome.kind,
      agentFailureLine(outcome),
    );
  }
  const raw = JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown;
  if (outcome.brief.kind === 'templated_report') {
    const parsed = validateTemplatedReport(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid templated report artifact.');
    renderTemplated(context, parsed.value, { format, detail, options }, outcome.brief);
  } else {
    const parsed = validateBrief(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid Brief artifact.');
    renderBrief(context, { brief: parsed.value, artifacts: null }, { format, detail, options });
  }
  await runtime.recordHistory(outcome.runId);
  if (options.open === true) context.openExternal(outcome.brief.htmlPath);
  const exitCode = exitCodeForAgenticOutcome(outcome);
  if (exitCode !== 0) throw new Error(`Agentic ask exited with ${exitCode}.`);
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

function resolveNoColor(options: AskOptions, context: CommandContext): boolean {
  if (options.color === false) {
    return true;
  }
  if (context.settings.env().NO_COLOR !== undefined && context.settings.env().NO_COLOR !== '') {
    return true;
  }
  return !context.output.colorCapable;
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
