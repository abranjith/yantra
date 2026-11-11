/**
 * The app host process's composition root (FEAT-065 TASK-005).
 *
 * Start order, each step undone if a later one fails:
 *
 * 1. acquire `host.lock` (`starting`), recording when the environment the
 *    host hands its workers was captured (D13);
 * 2. bind HTTP on 127.0.0.1 (static assets, `POST /session`, `/rpc`);
 * 3. bind the token-authenticated control socket;
 * 4. `markReady`.
 *
 * Stop closes listeners and sockets and releases the lock. Workers are never
 * signalled (D6). Dependencies are explicit so tests run a whole host
 * in-process.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FileHostLock,
  HostLockHeldError,
  hostStartFailurePath,
  writeFileAtomic,
  type ProcessIdentity,
} from '@yantra/core';
import { APP_CHANNEL_VERSION, type HostLockRecord } from '@yantra/protocol';

import { ControlSocketServer } from './control-socket.js';
import { HostStartError } from './errors.js';
import { AppHost, SILENT_HOST_LOGGER, type HostLogger, type HostRoute } from './host.js';
import { RpcMethodRegistry, RpcServer } from './rpc-server.js';
import { SessionStore, sessionRoute } from './sessions.js';

export interface HostRuntimeDeps {
  /** The embedded web build (`dist/web`). */
  readonly assetsRoot: string;
  readonly identity: ProcessIdentity;
  readonly yantraVersion: string;
  readonly lock?: FileHostLock;
  readonly logger?: HostLogger;
  readonly now?: () => Date;
  /** Extra HTTP routes (artifact URLs, TASK-010). */
  readonly routes?: readonly HostRoute[];
  /** Registers feature RPC methods (reads, supervisor, …) before the server starts. */
  readonly registerMethods?: (methods: RpcMethodRegistry, host: RunningHostCore) => void;
}

/** The parts of a running host other modules attach to. */
export interface RunningHostCore {
  readonly sessions: SessionStore;
  readonly buildId: string;
  readonly logger: HostLogger;
}

/** A started host. */
export interface RunningHost extends RunningHostCore {
  readonly port: number;
  readonly record: HostLockRecord;
  readonly rpc: RpcServer;
  readonly http: AppHost;
  readonly control: ControlSocketServer;
  /** Stops listening, closes every socket and releases the lock. Idempotent. */
  stop(): Promise<void>;
}

/** Reads `build_id` from the embedded build's `build-id.json`. */
export async function readBuildId(assetsRoot: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(assetsRoot, 'build-id.json'), 'utf8')) as {
      build_id?: unknown;
    };
    if (typeof parsed.build_id === 'string' && parsed.build_id.length > 0) return parsed.build_id;
  } catch {
    // Falls through to the error below.
  }
  throw new HostStartError(
    'assets_missing',
    `The Yantra app build ID is missing from ${assetsRoot}.`,
    'Rebuild Yantra (pnpm build).',
  );
}

/** Starts the host; see the module comment. */
export async function startHostRuntime(deps: HostRuntimeDeps): Promise<RunningHost> {
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  const now = deps.now ?? (() => new Date());
  const lock = deps.lock ?? new FileHostLock();
  const buildId = await readBuildId(deps.assetsRoot);
  const envCapturedAt = now().toISOString();

  let acquired: HostLockRecord;
  try {
    acquired = await lock.acquire(deps.identity, {
      build_id: buildId,
      yantra_version: deps.yantraVersion,
      channel_version: APP_CHANNEL_VERSION,
      env_captured_at: envCapturedAt,
    });
  } catch (error) {
    if (error instanceof HostLockHeldError) {
      throw new HostStartError('lock_held', error.message, error.remediation);
    }
    throw error;
  }

  const cleanups: (() => Promise<void> | void)[] = [
    async () => {
      await lock.release();
    },
  ];
  const undo = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await Promise.resolve(cleanup()).catch(() => undefined);
    }
  };

  try {
    const sessions = new SessionStore({ now: () => now().getTime() });
    const methods = new RpcMethodRegistry();
    const core: RunningHostCore = { sessions, buildId, logger };
    const rpc = new RpcServer({
      sessions,
      methods,
      buildId: () => buildId,
      yantraVersion: deps.yantraVersion,
      logger,
      now,
    });
    cleanups.push(() => {
      rpc.close();
    });
    deps.registerMethods?.(methods, core);
    const http = new AppHost({
      assetsRoot: deps.assetsRoot,
      logger,
      routes: [sessionRoute(sessions, () => buildId), ...(deps.routes ?? [])],
      upgrade: rpc.handleUpgrade,
    });
    const { port } = await http.start();
    cleanups.push(() => http.stop());

    const startedAt = now().toISOString();
    const control = await ControlSocketServer.listen({
      token: acquired.control_token,
      logger,
      issueLaunchCode: () => sessions.issueLaunchCode(),
      status: () => ({
        pid: deps.identity.pid,
        port,
        build_id: buildId,
        yantra_version: deps.yantraVersion,
        started_at: startedAt,
      }),
    });
    cleanups.push(() => control.close());

    const record = await lock.markReady({ port, control_socket: control.address });
    logger.info(
      {
        port,
        build_id: buildId,
        yantra_version: deps.yantraVersion,
        env_captured_at: envCapturedAt,
      },
      'host started',
    );
    let stopped = false;
    return {
      ...core,
      port,
      record,
      rpc,
      http,
      control,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await undo();
        logger.info({}, 'host stopped');
      },
    };
  } catch (error) {
    await undo();
    throw error;
  }
}

/** What a failed host start records for `yantra ui`. */
export interface HostStartFailure {
  readonly pid: number;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly at: string;
}

/** Records why this host could not start (owner-only, atomic). */
export async function recordStartFailure(failure: HostStartFailure): Promise<void> {
  await writeFileAtomic(hostStartFailurePath(), `${JSON.stringify(failure)}\n`, { mode: 0o600 });
}

/** Reads the last recorded start failure, if it is `pid`'s. */
export async function readStartFailure(pid: number): Promise<HostStartFailure | null> {
  try {
    const parsed = JSON.parse(await readFile(hostStartFailurePath(), 'utf8')) as HostStartFailure;
    return parsed.pid === pid ? parsed : null;
  } catch {
    return null;
  }
}
