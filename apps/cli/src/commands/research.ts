import { readFile } from 'node:fs/promises';

import {
  resolveCommandTaskProfile,
  type runAgenticTask,
  type ActiveReportTemplate,
} from '@yantra/agent';
import {
  ConfigBrowserSelectionReader,
  FileTemplateStore,
  templatesRoot,
  contentIdentity,
  type ExecutionReceiptDraft,
  BlocklistImpl,
  BrowserFallbackFetcher,
  DeterministicSynthesizer,
  EthicsGateImpl,
  FollowUpQueryGenerator,
  HttpFetcher,
  HybridContentFetcher,
  createSelectedBrowserProvider,
  type BrowserRuntimeOptions,
  type BrowserSelection,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  ResearchLoop,
  RobotsCacheImpl,
  createAskEthicsAdapter,
  createKeychainProvider,
  launchPerUsePageSource,
  loadEthicsConfig,
  loadSearchConfig,
  resolveSearchProvider,
  type EffectivePreferences,
  type Logger,
  type ResearchOptions,
  type ResearchRunResult,
  type SearchProviderName,
  type SynthesisLength,
  UserInputMarkerError,
} from '@yantra/core';
import {
  COMMAND_REGISTRY,
  SCHEMA_VERSION,
  validateBrief,
  validateTemplatedReport,
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
import { recordTaskHistory } from '../history.js';
import { resolveAmbientContext, type ResolvedAmbientContext } from '../preferences.js';
import { attachRegistered } from '../registry/build-command-tree.js';
import { handler, type Handler, type HandlerArgs } from '../registry/handler.js';
import { renderGoalEcho } from '../render/goal-echo.js';
import { JSONRenderer } from '../render/json.js';
import { TerminalRenderer } from '../render/terminal.js';
import type { BriefDetailLevel, BriefOutputFormat, ConnectorRenderOpts } from '../render/types.js';
import {
  resolveResearchBrowse,
  type NoBrowseOption,
  type ResearchBrowseResolution,
} from '../research-browse.js';
import { createBestEffortRankSignalSink, runAgenticTaskWithRankSink } from '../runtime.js';
import { TEMPLATE_LLM_GUARD, resolveTemplateRef } from '../template-ref.js';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface ResearchCommandOptions extends AgentOptions, BrowserSelectionOptions, NoBrowseOption {
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
  readonly maxLlmCalls?: string;
  readonly fetchTimeout?: string;
  readonly pipelineTimeout?: string;
  readonly perQueryLimit?: string;
  readonly template?: string;
}

/** The parsed inputs a research invocation needs. */
export interface ResearchInvocation {
  readonly options: ResearchOptions;
  readonly searchProvider: SearchProviderName | null;
}

export interface ResearchRuntime {
  readonly createLoop: (
    invocation: ResearchInvocation,
    browser?: BrowserRuntimeOptions,
  ) => Promise<ResearchLoop>;
  readonly resolveDefaults: () => Promise<EffectivePreferences>;
  readonly runTask: typeof runAgenticTask;
  readonly resolveAgent: typeof resolveAgentInvocation;
  readonly resolveTemplate: (ref: string) => Promise<ActiveReportTemplate>;
  readonly recordHistory: (runId: string) => Promise<void>;
}

/**
 * Registers the `research` subcommand: a bounded multi-hop
 * `search → fetch → synthesize → follow-up → repeat` loop producing one
 * long-form Brief (styled terminal / md / html / json).
 */
export function registerResearchCommand(
  program: Command,
  runtime?: Partial<ResearchRuntime> & TerminalOptions,
  context?: CommandContext,
): void {
  attachRegistered(program, 'research', { research: makeResearchHandler(runtime, context) });
}

/** The `research` handler over an injectable runtime, bound to the `research` registry entry. */
export function makeResearchHandler(
  runtime?: Partial<ResearchRuntime> & TerminalOptions,
  context: CommandContext = createTerminalContext(runtime),
): Handler {
  const resolvedRuntime = runtimeWithDefaults(context, runtime);
  return handler(
    async (args: HandlerArgs, options: ResearchCommandOptions, command: Command): Promise<void> => {
      const [topicArg] = args as readonly [string];
      const registryEntry = COMMAND_REGISTRY.commands.find((entry) => entry.id === 'research');
      if (registryEntry?.kind === 'leaf') context.settings.bind(registryEntry, command);

      // A conflicting `--browser` pair is a validation failure, resolved before
      // any loop or provider session exists.
      const browserSelection = resolveBrowserSelectionOverride(options);
      const effective = await resolvedRuntime.resolveDefaults();
      context.settings.usePreferences(effective);
      const agent = await resolvedRuntime.resolveAgent(
        'research',
        options,
        context.settings.env(),
        effective,
      );
      if (agent.mode === 'no-llm' && agent.reason === 'unavailable') {
        context.output.stderr.write(
          `warning: model ${agent.model.provider}/${agent.model.id} is unavailable because no credential resolved; ` +
            'configure provider auth or pass --auth-secret <ref>; using deterministic research\n',
        );
      }
      const invocation = buildInvocation(topicArg, options, agent.mode === 'no-llm');
      const format = resolveFormat(options);
      const detail = (options.detail ?? 'standard') as BriefDetailLevel;
      if (options.template !== undefined && invocation.options.noLlm) {
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
        context.output.stderr.write(
          'warning: --detail and --length do not affect template-defined report structure\n',
        );
      }
      const browse = resolveResearchBrowse(options, effective);
      // A scripted `--no-browse` must keep working when credentials go
      // missing, so the deterministic path warns and continues.
      if (agent.mode === 'no-llm' && options.browse === false) {
        context.output.stderr.write(
          'warning: --no-browse has no effect on deterministic research, which never opens a browsing session\n',
        );
      }

      const configuredBrowser =
        browserSelection === undefined
          ? await new ConfigBrowserSelectionReader().read()
          : undefined;
      const selection = browserSelection ??
        configuredBrowser ?? { source: 'auto' as const, executablePath: null };
      const templatePath =
        template?.path ??
        (template?.name ? new FileTemplateStore(templatesRoot()).pathFor(template.name) : null);
      const content = templatePath ? [await contentIdentity('template', templatePath)] : [];
      const effectiveSettings: Readonly<Record<string, unknown>> = {
        depth: invocation.options.budget.maxHops,
        maxSources: invocation.options.budget.maxSources,
        llm: !invocation.options.noLlm,
        format,
        detail,
        length: invocation.options.length,
        searchProvider: invocation.searchProvider,
        perQueryLimit: invocation.options.perQueryLimit,
        fetchTimeout: invocation.options.perFetchTimeoutMs,
        pipelineTimeout: invocation.options.budget.maxWallClockMs,
        maxLlmCalls: invocation.options.budget.maxLlmCalls,
      };
      for (const [key, value] of Object.entries(effectiveSettings))
        await context.settings.effective(key, value);
      context.settings.record(
        'browse',
        browse.enabled,
        browse.source === 'preference'
          ? { kind: 'preference', key: 'agent.research_browse' }
          : { kind: browse.source },
      );
      if (options.json) context.settings.record('format', format, { kind: 'flag' });
      if (agent.mode === 'llm') {
        await context.settings.effective('provider', agent.model.provider);
        await context.settings.effective('model', agent.model.id);
        await context.settings.effective('thinking', agent.model.thinking ?? null);
      }
      const browserSource = browserSelection
        ? { kind: 'flag' as const }
        : configuredBrowser
          ? { kind: 'config' as const, key: 'browser.source' }
          : { kind: 'default' as const };
      context.settings.record('browser', selection.source, browserSource);
      context.settings.record('browserPath', selection.executablePath, browserSource);
      const receipt = await context.settings.draftReceipt(['research'], {
        content,
        browser: {
          selection,
          source: browserSelection
            ? { kind: 'flag' }
            : configuredBrowser
              ? { kind: 'config', key: 'browser.source' }
              : { kind: 'default' },
        },
      });

      // Resolved before the try so a bad --provider/--model is a validation
      // failure (exit 1) rather than being reclassified as an execution failure
      // by the catch below. Skipped entirely in deterministic mode, which never
      // constructs a provider session.
      context.output.stderr.write(
        `research: search-provider=${invocation.searchProvider ?? 'auto'} ` +
          `depth=${invocation.options.budget.maxHops} max-sources=${invocation.options.budget.maxSources} ` +
          `no-llm=${invocation.options.noLlm} detail=${detail} format=${format}` +
          (agent.mode === 'no-llm'
            ? ''
            : ` model=${agent.model.provider}/${agent.model.id} browse=${browse.enabled ? 'on' : 'off'}`) +
          '\n',
      );
      // The goal exactly as received, so a shell-rewritten argument is visible.
      context.output.stderr.write(renderGoalEcho(topicArg));

      try {
        // Deterministic selection is resolved before any agent/provider setup.
        if (agent.mode === 'llm') {
          await runAgenticResearch(
            topicArg,
            invocation,
            format,
            detail,
            options,
            resolvedRuntime,
            context,
            template,
            agent,
            resolveAmbientContext(effective),
            browserSelection,
            browse,
            receipt,
          );
          return;
        }
        const loop = await resolvedRuntime.createLoop(invocation, {
          installOfferGateway: context.gateways.installOffer(
            context.isInteractive({ json: format === 'json' }),
          ),
          ...(browserSelection === undefined ? {} : { selection: browserSelection }),
        });
        const result: ResearchRunResult = await loop.run({ ...invocation.options, receipt });

        renderBrief(context, result, { format, detail, options });

        if (options.open === true && result.artifacts !== null) {
          context.openExternal(result.artifacts.htmlPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof UserInputMarkerError) {
          context.output.stderr.write(`research validation failed: ${message}\n`);
          throw new CommanderError(1, 'yantra.research.invalid-user-input-marker', message);
        }
        context.output.stderr.write(`research failed: ${message}\n`);
        throw new CommanderError(2, 'yantra.research.failed', message);
      }
    },
  );
}

/** Renders the Brief through the unified connector dispatch (same as `ask`). */
function renderBrief(
  context: CommandContext,
  result: ResearchRunResult,
  view: { format: BriefOutputFormat; detail: BriefDetailLevel; options: ResearchCommandOptions },
): void {
  if (view.format === 'json') {
    context.output.json({
      schemaVersion: SCHEMA_VERSION,
      kind: 'brief',
      brief: result.brief,
      artifacts: result.artifacts,
    });
    return;
  }
  const renderer = new TerminalRenderer();
  const io = context.connector(renderer);

  const opts: ConnectorRenderOpts = {
    json: false,
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

/**
 * Constructs the default research loop. Like `ask`, the synthesizer and
 * query generator use the deterministic strategies by default (the
 * agent-optional invariant); the LLM ports are injected in tests and will be
 * wired to the shared live agent runtime alongside agentic `ask` synthesis.
 */
export async function createDefaultResearchLoop(
  invocation: ResearchInvocation,
  browser: BrowserRuntimeOptions = {},
  env: Readonly<NodeJS.ProcessEnv> = {},
): Promise<ResearchLoop> {
  const logger = noopLogger;

  const profileStore = new LocalProfileStore({ logger });
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
    taskId: 'research',
    runId: 'research',
    stepId: 'research',
    action: 'fetch',
  });

  const keychain = await createKeychainProvider();
  const searchConfig = await loadSearchConfig();
  const resolved = await resolveSearchProvider({
    explicitProvider: invocation.searchProvider,
    env,
    config: searchConfig,
    deps: { keychain, pages, ethicsGate: askEthicsGate, logger },
  });
  if (!resolved.isOk) {
    throw resolved.error;
  }

  const fetcher = new HybridContentFetcher({
    httpFetcher: new HttpFetcher(),
    browserFetcher: new BrowserFallbackFetcher({ pages }),
  });
  const rankSink = await createBestEffortRankSignalSink(logger);

  return new ResearchLoop({
    searchProvider: resolved.value,
    fetcher,
    extractor: new ReadabilityExtractor(),
    ethicsGate: askEthicsGate,
    synthesizer: new DeterministicSynthesizer(),
    queryGen: new FollowUpQueryGenerator(),
    logger,
    ...(rankSink === null ? {} : { rankSink }),
  });
}

function runtimeWithDefaults(
  context: CommandContext,
  runtime?: Partial<ResearchRuntime>,
): ResearchRuntime {
  return {
    createLoop:
      runtime?.createLoop ??
      ((invocation, browser) =>
        createDefaultResearchLoop(invocation, browser, context.settings.env())),
    resolveDefaults: runtime?.resolveDefaults ?? (() => context.settings.preferences()),
    runTask: runtime?.runTask ?? runAgenticTaskWithRankSink,
    resolveAgent: runtime?.resolveAgent ?? resolveAgentInvocation,
    resolveTemplate:
      runtime?.resolveTemplate ??
      ((ref) =>
        resolveTemplateRef(ref, {
          isTty: context.isInteractive({}),
          cwd: context.cwd,
          choose: (choices) => context.input.choose(choices),
        })),
    recordHistory: runtime?.recordHistory ?? ((runId) => recordTaskHistory(runId)),
  };
}

async function runAgenticResearch(
  topic: string,
  invocation: ResearchInvocation,
  format: BriefOutputFormat,
  detail: BriefDetailLevel,
  options: ResearchCommandOptions,
  runtime: ResearchRuntime,
  context: CommandContext,
  template: ActiveReportTemplate | undefined,
  agent: Extract<AgentInvocation, { readonly mode: 'llm' }>,
  ambient: ResolvedAmbientContext,
  browserSelection: BrowserSelection | undefined,
  browse: ResearchBrowseResolution,
  receipt: ExecutionReceiptDraft,
): Promise<void> {
  const renderOpts: ConnectorRenderOpts = {
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
  const connector = context.connector(
    format === 'json' ? new JSONRenderer() : new TerminalRenderer(),
    {
      renderOpts,
      interactive: context.isInteractive({ json: format === 'json' }),
      suppressPublishedOutcome: true,
    },
  );
  const profile = resolveCommandTaskProfile('research', { browse: browse.enabled });
  const outcome = await runtime.runTask(
    {
      goal: topic,
      receipt,
      signal: context.signal,
      model: agent.model,
      ...(agent.thinkingSource === undefined ? {} : { thinkingSource: agent.thinkingSource }),
      auth: agent.auth,
      profile,
      budgets: agent.budgets,
      ...(template === undefined ? {} : { template }),
      ambient,
      screenshotsSuppressed: options.screenshots === false,
      connector,
    },
    {
      browserInstallOfferGateway: context.gateways.installOffer(
        context.isInteractive({ json: format === 'json' }),
      ),
      ...(browserSelection === undefined ? {} : { browserSelection }),
    },
  );
  if (outcome.kind !== 'published') {
    throw new Error(agentFailureLine(outcome));
  }
  const raw = JSON.parse(await readFile(outcome.brief.jsonPath, 'utf8')) as unknown;
  if (outcome.brief.kind === 'templated_report') {
    const parsed = validateTemplatedReport(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid templated report artifact.');
    const renderer = format === 'json' ? new JSONRenderer() : new TerminalRenderer();
    context.connector(renderer).renderResult(
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
  } else {
    const parsed = validateBrief(raw);
    if (!parsed.isOk) throw new Error('The agent published an invalid Brief artifact.');
    renderBrief(
      context,
      { brief: parsed.value, artifacts: null, hops: [], terminationReason: 'coverage_met' },
      { format, detail, options },
    );
  }
  await runtime.recordHistory(outcome.runId);
  if (options.open === true) context.openExternal(outcome.brief.htmlPath);
}

function buildInvocation(
  topic: string,
  options: ResearchCommandOptions,
  noLlm: boolean,
): ResearchInvocation {
  const maxHops = clampInt(options.depth, 2, 1, 3);
  const maxSources = clampInt(options.maxSources, 24, 1, 100);
  const maxWallClockMs = noLlm
    ? Math.min(
        600_000,
        Math.max(1_000, parseDuration(options.pipelineTimeout ?? '3m', '--pipeline-timeout')),
      )
    : 180_000;
  const maxLlmCalls = clampInt(options.maxLlmCalls, 12, 1, 100);

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

function resolveNoColor(options: ResearchCommandOptions, context: CommandContext): boolean {
  if (options.color === false) {
    return true;
  }
  if (context.settings.env().NO_COLOR !== undefined && context.settings.env().NO_COLOR !== '') {
    return true;
  }
  return !context.output.colorCapable;
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
