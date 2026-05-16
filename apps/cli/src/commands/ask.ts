import {
  AskPipeline,
  BlocklistImpl,
  BrowserFallbackFetcher,
  DefaultSanitizer,
  EthicsGateImpl,
  FileSystemAskCache,
  HttpFetcher,
  HybridContentFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ReadabilityExtractor,
  RateLimiterImpl,
  RobotsCacheImpl,
  RuleBasedSummarizer,
  createAskEthicsAdapter,
  createKeychainProvider,
  createLlmSummarizer,
  loadEthicsConfig,
  renderJson,
  renderTerminal,
  selectSearchProvider,
  type AskQuery,
  type Logger,
  type SearchProviderName,
} from '@yantra/core';
import { CommanderError, Option, type Command } from 'commander';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

interface AskOptions {
  readonly json?: boolean;
  readonly noLlm?: boolean;
  readonly llm?: boolean;
  readonly noCache?: boolean;
  readonly budget?: string;
  readonly searchProvider?: string;
  readonly limit?: string;
  readonly fetchTimeout?: string;
  readonly budgetMs?: string;
}

export interface AskRuntime {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly createPipeline: (query: AskQuery) => Promise<AskPipeline>;
}

/**
 * Registers the `ask` subcommand.
 */
export function registerAskCommand(program: Command, runtime?: Partial<AskRuntime>): void {
  const resolvedRuntime = runtimeWithDefaults(runtime);

  program
    .command('ask')
    .description('Run the ask pipeline (search -> fetch -> extract -> summarize).')
    .argument('<query>', 'question to answer from web sources')
    .addOption(new Option('--json', 'print machine-readable JSON output').default(false))
    .addOption(new Option('--no-llm', 'force rule-based summarization path').default(false))
    .addOption(new Option('--no-cache', 'disable cache reads/writes').default(false))
    .addOption(new Option('--budget <calls>', 'maximum sources to fetch'))
    .addOption(
      new Option('--search-provider <provider>', 'search provider: auto|tavily|brave|browser').choices([
        'auto',
        'tavily',
        'brave',
        'browser',
      ]),
    )
    .addOption(new Option('--limit <count>', 'number of cards to return').default('3'))
    .addOption(new Option('--fetch-timeout <ms>', 'per-fetch timeout in ms').default('8000'))
    .addOption(new Option('--budget-ms <ms>', 'pipeline timeout budget in ms').default('30000'))
    .action(async (queryArg: string, options: AskOptions) => {
      const query = buildAskQuery(queryArg, options, resolvedRuntime.env);

      resolvedRuntime.stderr.write(
        `ask: provider=${query.searchProvider ?? 'auto'} limit=${query.limit} no-llm=${query.noLlm}\n`,
      );

      try {
        const pipeline = await resolvedRuntime.createPipeline(query);
        const cards = await pipeline.run(query);

        if (options.json === true) {
          resolvedRuntime.stdout.write(`${JSON.stringify(renderJson(cards), null, 2)}\n`);
        } else {
          resolvedRuntime.stdout.write(`${renderTerminal(cards, { color: false, width: 80 })}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        resolvedRuntime.stderr.write(`ask failed: ${message}\n`);
        throw new CommanderError(2, 'yantra.ask.failed', message);
      }
    });
}

/**
 * Constructs the default ask pipeline used by the CLI.
 */
export async function createDefaultAskPipeline(query: AskQuery): Promise<AskPipeline> {
  const logger = noopLogger;

  const profileStore = new LocalProfileStore({ logger });
  const browserProvider = new LocalBrowserProvider({ profileStore, logger });

  const ethicsConfig = await loadEthicsConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const robots = new RobotsCacheImpl(ethicsConfig.userAgent);
  const rateLimiter = new RateLimiterImpl(ethicsConfig.rateLimitDefault, ethicsConfig.rateLimitOverrides, {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  });
  const ethicsGate = new EthicsGateImpl(blocklist, robots, rateLimiter, ethicsConfig.userAgent);
  const askEthicsGate = createAskEthicsAdapter(ethicsGate, {
    taskId: 'ask',
    runId: 'ask',
    stepId: 'ask',
    action: 'fetch',
  });

  const keychain = await createKeychainProvider();
  const searchProvider = await selectSearchProvider({
    explicitProvider: query.searchProvider ?? 'auto',
    keychain,
    browserProvider,
    ethicsGate: askEthicsGate,
    logger,
  });

  const fetcher = new HybridContentFetcher({
    httpFetcher: new HttpFetcher(),
    browserFetcher: new BrowserFallbackFetcher({ browserProvider }),
  });

  const llmSummarizer = createLlmSummarizer({
    llmClient: null,
    sanitizer: new DefaultSanitizer(),
    featureGate: { llmSummarize: false },
    noLlm: query.noLlm,
  });

  return new AskPipeline({
    searchProvider,
    fetcher,
    extractor: new ReadabilityExtractor(),
    ruleBasedSummarizer: new RuleBasedSummarizer(),
    llmSummarizer,
    cache: new FileSystemAskCache(),
    ethicsGate: askEthicsGate,
    logger,
  });
}

function runtimeWithDefaults(runtime?: Partial<AskRuntime>): AskRuntime {
  return {
    env: runtime?.env ?? process.env,
    stdout: runtime?.stdout ?? process.stdout,
    stderr: runtime?.stderr ?? process.stderr,
    createPipeline: runtime?.createPipeline ?? createDefaultAskPipeline,
  };
}

function buildAskQuery(raw: string, options: AskOptions, env: NodeJS.ProcessEnv): AskQuery {
  const limit = clampInt(options.limit, 3, 1, 10);
  const budgetCalls = parseNullablePositiveInt(options.budget);
  const provider = parseProvider(options.searchProvider);
  const noLlm = options.noLlm === true || options.llm === false || env.LLM_PROVIDER === 'none';

  return {
    raw,
    normalized: raw.trim().replace(/\s+/g, ' ').toLowerCase(),
    limit,
    noCache: options.noCache === true,
    noLlm,
    budgetCalls,
    searchProvider: provider,
    perFetchTimeoutMs: clampInt(options.fetchTimeout, 8_000, 1_000, 120_000),
    pipelineBudgetMs: clampInt(options.budgetMs, 30_000, 1_000, 300_000),
  };
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

  if (raw === 'tavily' || raw === 'brave' || raw === 'browser') {
    return raw;
  }

  return null;
}
