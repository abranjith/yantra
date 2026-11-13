/**
 * `AppHost`: the app host's HTTP composition root (FEAT-065, plan D1–D6, D18).
 *
 * It binds `node:http` to `127.0.0.1` on an ephemeral port, never to
 * `0.0.0.0`, `::` or `localhost`, runs the request guard before every route,
 * and serves the embedded web build. Everything else (sessions, artifact URLs,
 * the WebSocket upgrade) plugs in as a {@link HostRoute} or upgrade handler
 * with explicit dependencies; the host holds no task logic (memory →
 * Architecture).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import { HostStartError } from './errors.js';
import { checkRequest, isSafeMethod, sendStatus } from './request-guard.js';
import { StaticAssets } from './static-assets.js';

/** The only address the host ever listens on. */
export const LOOPBACK_ADDRESS = '127.0.0.1';

/** Structured logger the host writes to (Pino-compatible). */
export interface HostLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** A logger that drops everything (tests and `--print` probes). */
export const SILENT_HOST_LOGGER: HostLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** What a route sees besides the request: the bound port. */
export interface HostRouteContext {
  readonly port: number;
}

/**
 * A route runs after the guard. It returns true when it handled (and answered)
 * the request, false to let the next route try.
 */
export type HostRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  context: HostRouteContext,
) => Promise<boolean>;

/** Handles an HTTP upgrade (the WebSocket endpoint); it owns the socket. */
export type HostUpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  context: HostRouteContext,
) => void;

export interface AppHostDeps {
  /** The embedded web build directory (`dist/web`). */
  readonly assetsRoot: string;
  readonly logger?: HostLogger;
  /** Routes tried in order before static assets. */
  readonly routes?: readonly HostRoute[];
  readonly upgrade?: HostUpgradeHandler;
}

/** The app host's HTTP server; see the module comment. */
export class AppHost {
  private server: Server | null = null;
  private boundPort: number | null = null;
  private assets: StaticAssets | null = null;
  private readonly logger: HostLogger;
  private readonly rejections = new Map<string, number>();

  public constructor(private readonly deps: AppHostDeps) {
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
  }

  /** The bound port; throws before {@link start}. */
  public get port(): number {
    if (this.boundPort === null) throw new Error('The app host has not started.');
    return this.boundPort;
  }

  /** The underlying server, for attaching the WebSocket endpoint. */
  public get httpServer(): Server {
    if (this.server === null) throw new Error('The app host has not started.');
    return this.server;
  }

  /** Security rejections so far, keyed by reason (and rejected Origin host). */
  public rejectionCounts(): ReadonlyMap<string, number> {
    return this.rejections;
  }

  /**
   * Opens the assets and binds the loopback port.
   *
   * @throws HostStartError `assets_missing` or `bind_failed`.
   */
  public async start(): Promise<{ readonly port: number }> {
    this.assets = await StaticAssets.open(this.deps.assetsRoot);
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.logger.error({ err: errorName(error) }, 'request failed');
        if (!res.headersSent) sendStatus(res, this.port, 500);
        else res.destroy();
      });
    });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      socket.on('error', () => undefined);
      if (this.deps.upgrade === undefined) {
        socket.destroy();
        return;
      }
      this.deps.upgrade(req, socket, head, { port: this.port });
    });
    server.on('clientError', (_error, socket: Duplex) => {
      socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) => {
        reject(
          new HostStartError(
            'bind_failed',
            `The app host could not listen on ${LOOPBACK_ADDRESS}: ${error.code ?? error.message}.`,
            'Check that loopback networking is available, then run `yantra ui` again.',
          ),
        );
      });
      server.listen({ port: 0, host: LOOPBACK_ADDRESS, exclusive: true }, () => {
        resolve();
      });
    });
    this.server = server;
    this.boundPort = (server.address() as AddressInfo).port;
    return { port: this.boundPort };
  }

  /** Stops listening and closes every connection. Idempotent. */
  public async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const port = this.port;
    const refusal = checkRequest(req, port);
    if (refusal !== null) {
      this.countRejection(refusal.reason, req);
      sendStatus(res, port, refusal.status);
      return;
    }
    for (const route of this.deps.routes ?? []) {
      if (await route(req, res, { port })) return;
    }
    if (!isSafeMethod(req.method)) {
      sendStatus(res, port, 405, undefined, { Allow: 'GET, HEAD' });
      return;
    }
    await this.assets!.serve(req, res, port);
  }

  private countRejection(reason: 'host' | 'origin', req: IncomingMessage): void {
    const key = reason === 'origin' ? `origin:${originHost(req.headers.origin)}` : 'host';
    const count = (this.rejections.get(key) ?? 0) + 1;
    this.rejections.set(key, count);
    this.logger.warn(
      { reason, origin_host: originHost(req.headers.origin), count },
      'request refused',
    );
  }
}

/** The host part of a rejected Origin, for logs; never the full value. */
export function originHost(origin: string | undefined): string {
  if (origin === undefined) return '(none)';
  try {
    return new URL(origin).host || '(opaque)';
  } catch {
    return '(invalid)';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
