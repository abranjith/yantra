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
  createKeychainProvider,
  loadEthicsConfig,
  workflowsRoot,
  type KeychainProvider,
  type Logger,
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
  } = {},
): Promise<OrchestratorRuntime> {
  const logger = opts.logger ?? noopLogger;

  const keychain: KeychainProvider = await createKeychainProvider();
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
  });

  return { orchestrator, runStore, workflowStore, logger };
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
