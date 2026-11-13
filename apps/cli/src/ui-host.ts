/**
 * The app host process (FEAT-065 TASK-005), built to `dist/ui-host.js` and
 * started detached by `yantra ui`. Not a `bin` entry.
 *
 * Usage: `node dist/ui-host.js` with the CLI's environment and the data
 * directory as cwd. It logs only to `host.log`; a start failure is also
 * recorded for `yantra ui` and the process exits 3.
 */

import { fileURLToPath } from 'node:url';

import { currentProcessIdentity, dataDir, hostLogPath, yantraVersion } from '@yantra/core';

import { HostStartError } from './ui/host/errors.js';
import { openHostLog } from './ui/host/host-log.js';
import { recordStartFailure, startHostRuntime } from './ui/host/host-runtime.js';

/** Overrides the embedded web build directory; tests only. */
const ASSETS_ENV = 'YANTRA_UI_ASSETS_DIR';

const assetsOverride = process.env[ASSETS_ENV]?.trim();
const assetsRoot =
  assetsOverride !== undefined && assetsOverride.length > 0
    ? assetsOverride
    : fileURLToPath(new URL('./web/', import.meta.url));
const log = openHostLog(hostLogPath());
const identity = await currentProcessIdentity();

let onIdle: () => void = () => undefined;
try {
  const host = await startHostRuntime({
    onIdle: () => {
      onIdle();
    },
    assetsRoot,
    identity,
    yantraVersion: yantraVersion(),
    logger: log.logger,
    env: process.env,
    cwd: dataDir(),
  });
  const shutdown = (signal: string): void => {
    log.logger.info({ signal }, 'host shutting down');
    void host.stop().finally(() => {
      log.flush();
      process.exitCode = 0;
    });
  };
  onIdle = () => {
    shutdown('idle');
  };
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGBREAK', () => {
    shutdown('SIGBREAK');
  });
} catch (error) {
  const failure =
    error instanceof HostStartError
      ? { code: error.code, message: error.message, remediation: error.remediation }
      : {
          code: 'start_failed',
          message: error instanceof Error ? error.message : String(error),
          remediation: `See ${hostLogPath()}.`,
        };
  log.logger.error({ reason: failure.code }, 'host failed to start');
  log.flush();
  await recordStartFailure({ pid: process.pid, ...failure, at: new Date().toISOString() }).catch(
    () => undefined,
  );
  process.exitCode = 3;
}
