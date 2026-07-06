/**
 * Shared CLI runtime builders.
 *
 * Constructs the dependency graph required by the workflow orchestrator
 * (browser provider, profile store, ethics gate, keychain, workflow store,
 * run store) so individual subcommands don't repeat the wiring.
 */

import {
  BlocklistImpl,
  DefaultSanitizer,
  EthicsGateImpl,
  FileWorkflowStore,
  LocalBrowserProvider,
  LocalProfileStore,
  RateLimiterImpl,
  RobotsCacheImpl,
  SqliteRateLimitStore,
  createKeychainProvider,
  loadEthicsConfig,
  openIndexDb,
  workflowsRoot,
  type ConfirmationGateway,
  type KeychainProvider,
  type Logger,
  type RateLimitStore,
} from '@yantra/core';
import { LocalRunStore, RunOrchestrator } from '@yantra/core/workflow/replay';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export interface OrchestratorRuntime {
  readonly orchestrator: RunOrchestrator;
  readonly runStore: LocalRunStore;
  readonly workflowStore: FileWorkflowStore;
  readonly logger: Logger;
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
  } = {},
): Promise<OrchestratorRuntime> {
  const logger = opts.logger ?? noopLogger;

  const keychain: KeychainProvider = await createKeychainProvider();
  const ethicsConfig = await loadEthicsConfig();
  const blocklist = new BlocklistImpl();
  await blocklist.reload();
  const robots = new RobotsCacheImpl(ethicsConfig.userAgent);
  const rateLimitStore = await openRateLimitStore(logger);
  const rateLimiter = new RateLimiterImpl(
    ethicsConfig.rateLimitDefault,
    ethicsConfig.rateLimitOverrides,
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    rateLimitStore,
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
  });

  return { orchestrator, runStore, workflowStore, logger };
}

/**
 * Opens a persistent rate-limit store best-effort. Returns undefined when the
 * index is unavailable — the ethics gate then falls back to in-process-only
 * token buckets (identical to the MVP behavior).
 */
async function openRateLimitStore(logger: Logger): Promise<RateLimitStore | undefined> {
  try {
    const { db } = await openIndexDb({ logger });
    return new SqliteRateLimitStore({ db, logger });
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
