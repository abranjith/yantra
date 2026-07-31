/**
 * Shared CLI runtime builders.
 *
 * Constructs the dependency graph required by the workflow orchestrator
 * (browser provider, profile store, ethics gate, keychain, workflow store,
 * run store) so individual subcommands don't repeat the wiring.
 */

import { runAgenticTask, YANTRA_SYNTHESIS_PROMPT } from '@yantra/agent';
import {
  BlocklistImpl,
  DefaultSanitizer,
  DeterministicSynthesizer,
  EthicsGateImpl,
  FileWorkflowStore,
  LlmSynthesizer,
  LocalBrowserProvider,
  LocalProfileStore,
  RateLimiterImpl,
  RobotsCacheImpl,
  SqliteDomainRankStore,
  SqliteRateLimitStore,
  createKeychainProvider,
  loadEthicsConfig,
  openIndexDb,
  workflowsRoot,
  type ConfirmationGateway,
  type KeychainProvider,
  type Logger,
  type RankSignalSink,
  type RateLimitStore,
  type SynthesisLlm,
} from '@yantra/core';
import type { SynthesisRunContext, SynthesisStrategies } from '@yantra/core/workflow/replay';
import { LocalRunStore, RunOrchestrator } from '@yantra/core/workflow/replay';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

let rankStoreFailureWarned = false;

/**
 * Opens the local rank store and adapts it to the fire-and-forget ranking port.
 * Every failure is contained: the first is a process-level warning and later
 * failures are debug-only, so observation can never fail a user task.
 */
export async function createBestEffortRankSignalSink(
  logger: Logger,
): Promise<RankSignalSink | null> {
  try {
    const { db } = await openIndexDb({ logger });
    const store = new SqliteDomainRankStore({ db, logger });
    return {
      record: (signal) => {
        try {
          const result = store.applySignal(signal);
          if (!result.isOk) {
            logRankStoreFailure(logger, result.error);
          }
        } catch (error) {
          logRankStoreFailure(logger, error);
        }
      },
    };
  } catch (error) {
    logRankStoreFailure(logger, error);
    return null;
  }
}

/** Agentic runtime entrypoint with the same CLI-owned best-effort rank sink. */
export const runAgenticTaskWithRankSink: typeof runAgenticTask = async (
  request,
  dependencies = {},
) => {
  const rankSink =
    dependencies.rankSink === undefined
      ? await createBestEffortRankSignalSink(noopLogger)
      : dependencies.rankSink;
  return runAgenticTask(request, { ...dependencies, rankSink });
};

function logRankStoreFailure(logger: Logger, error: unknown): void {
  const details = { error: error instanceof Error ? error.message : String(error) };
  if (!rankStoreFailureWarned) {
    rankStoreFailureWarned = true;
    logger.warn(details, 'domain ranking unavailable; continuing without rank updates');
    return;
  }
  logger.debug(details, 'domain ranking update skipped');
}

export interface OrchestratorRuntime {
  readonly orchestrator: RunOrchestrator;
  readonly runStore: LocalRunStore;
  readonly workflowStore: FileWorkflowStore;
  readonly logger: Logger;
  /** Releases runtime-owned persistence handles. Idempotent. */
  readonly close: () => void;
}

/**
 * Synthesis wiring for `yantra run` (FEAT-FP-001).
 *
 * Omitting this disables the Synthesize stage entirely. Passing it with
 * `llm: null` still produces a Brief — deterministically, opening no provider
 * session. Supplying a port does *not* mean a model will be used: the stage
 * calls the factory only for a workflow whose `synthesis.use_llm` is set.
 */
export interface OrchestratorSynthesisOptions {
  /**
   * Builds the LLM port for one run, or null to stay deterministic.
   *
   * A factory because the port needs the run's id and directory (its session log
   * is an artifact of that run), and neither exists until the orchestrator
   * creates the run — and because most runs never call it at all.
   */
  readonly llm?: ((ctx: SynthesisRunContext) => SynthesisLlm) | null;
  /**
   * True when the caller vetoed the model (`--no-llm`, a scheduled fire);
   * forces the deterministic path regardless of what the workflow declares.
   */
  readonly noLlm?: boolean;
}

/**
 * Builds the Synthesize-stage strategies for one run.
 *
 * The deterministic synthesizer is always constructed — determinism must always
 * be reachable — and the LLM strategy is layered on top only when a port was
 * supplied, with the deterministic instance as its fallback target.
 */
function buildSynthesisStrategies(
  opts: OrchestratorSynthesisOptions,
  logger: Logger,
): SynthesisStrategies {
  const deterministic = new DeterministicSynthesizer();
  const portFor = opts.llm ?? null;

  return {
    deterministic,
    llm:
      portFor === null
        ? null
        : (ctx): LlmSynthesizer =>
            new LlmSynthesizer({
              llm: portFor(ctx),
              prompt: YANTRA_SYNTHESIS_PROMPT,
              deterministic,
              logger,
            }),
    noLlm: opts.noLlm === true,
  };
}

/**
 * Builds the default orchestrator + supporting stores used by `yantra run` /
 * `yantra resume`. Pure side-effect-free factory — actual launches happen
 * when the caller invokes `orchestrator.run()`.
 */
export async function buildOrchestratorRuntime(
  opts: {
    readonly logger?: Logger;
    /**
     * Human-in-the-loop consent gateway for `requires_confirmation` steps
     * (FEAT-019). Callers inject an `InteractiveConfirmationGateway` for
     * interactive TTY runs; omitting it keeps flagged steps fail-closed so
     * unattended surfaces cannot self-authorize (plan §6).
     */
    readonly confirmationGateway?: ConfirmationGateway | null;
    /**
     * Synthesize-stage wiring (FEAT-FP-001). Omit to disable the stage — which
     * is what every caller that must produce no Brief at all relies on. Pass
     * `{}` for a deterministic-only stage; add `llm` to let a workflow that
     * declared `synthesis.use_llm` reach a model.
     */
    readonly synthesis?: OrchestratorSynthesisOptions;
  } = {},
): Promise<OrchestratorRuntime> {
  const logger = opts.logger ?? noopLogger;

  const keychain: KeychainProvider = await createKeychainProvider();
  const ethicsConfig = await loadEthicsConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const robots = new RobotsCacheImpl(ethicsConfig.userAgent);
  const rateLimitHandle = await openRateLimitStore(logger);
  const rateLimiter = new RateLimiterImpl(
    ethicsConfig.rateLimitDefault,
    ethicsConfig.rateLimitOverrides,
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    rateLimitHandle?.store,
  );
  const ethicsGate = new EthicsGateImpl(blocklist, robots, rateLimiter, ethicsConfig.userAgent, {
    enforceRobotsTxt: ethicsConfig.robotsEnabled,
  });

  const profileStore = new LocalProfileStore({ logger });
  const browserProvider = new LocalBrowserProvider({ profileStore, logger });
  const workflowStore = new FileWorkflowStore(workflowsRoot());
  const runStore = new LocalRunStore();
  const sanitizer = new DefaultSanitizer();

  const orchestrator = new RunOrchestrator({
    workflowStore,
    runStore,
    browserProvider,
    keychain,
    sanitizer,
    ethicsGate,
    logger,
    confirmationGateway: opts.confirmationGateway ?? null,
    synthesis:
      opts.synthesis === undefined ? null : buildSynthesisStrategies(opts.synthesis, logger),
  });

  return {
    orchestrator,
    runStore,
    workflowStore,
    logger,
    close: () => rateLimitHandle?.close(),
  };
}

/**
 * Opens a persistent rate-limit store best-effort. Returns undefined when the
 * index is unavailable — the ethics gate then falls back to in-process-only
 * token buckets (identical to the MVP behavior).
 */
async function openRateLimitStore(
  logger: Logger,
): Promise<{ readonly store: RateLimitStore; readonly close: () => void } | undefined> {
  try {
    const { db } = await openIndexDb({ logger });
    return {
      store: new SqliteRateLimitStore({ db, logger }),
      close: () => {
        try {
          db.close();
        } catch {
          // Idempotent best-effort shutdown for command/test process teardown.
        }
      },
    };
  } catch {
    return undefined;
  }
}

export function makeStderrLogger(debug: boolean): Logger {
  if (!debug) return noopLogger;
  return {
    info: (obj, msg) => process.stderr.write(`[info]  ${msg ?? ''} ${stringify(obj)}\n`),
    warn: (obj, msg) => process.stderr.write(`[warn]  ${msg ?? ''} ${stringify(obj)}\n`),
    error: (obj, msg) => process.stderr.write(`[error] ${msg ?? ''} ${stringify(obj)}\n`),
    debug: (obj, msg) => process.stderr.write(`[debug] ${msg ?? ''} ${stringify(obj)}\n`),
  };
}

function stringify(obj: Record<string, unknown> | string): string {
  if (typeof obj === 'string') return obj;
  try {
    return JSON.stringify(obj);
  } catch {
    return '[unserializable]';
  }
}
