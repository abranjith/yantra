/**
 * The app's WebSocket JSON-RPC 2.0 endpoint (FEAT-065 TASK-004).
 *
 * Upgrade (`GET /rpc`): exact `Host`, exact `Origin` and a live session
 * cookie, or a raw 403 and the socket is destroyed. Then:
 *
 * - The first message must be `auth {window_capability}` matching the
 *   cookie's window, within 5 s; otherwise close 4401 with no reply.
 * - Messages over 1 MiB close the socket (`ws` `maxPayload`).
 * - Every request is validated against its method's Zod params schema, and
 *   every result against its result schema.
 * - The server pings every 15 s and terminates a socket that misses two
 *   pongs. A window whose session expires has its sockets closed with 4401.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  APP_CHANNEL_VERSION,
  APP_RPC_CLOSE_UNAUTHORIZED,
  AppRpcAuth,
  AppRpcErrorCode,
  EmptyParams,
  HostHelloParams,
  HostHelloResult,
  JsonRpcRequest,
  MAX_APP_RPC_MESSAGE_BYTES,
  SessionCodeResult,
  type AppRpcErrorData,
  type AppRpcErrorName,
  type JsonRpcId,
  type JsonRpcResponse,
} from '@yantra/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { z } from 'zod';

import { SILENT_HOST_LOGGER, type HostLogger, type HostRouteContext } from './host.js';
import { hostMatches, originMatches } from './request-guard.js';
import { readSessionCookie, type SessionStore } from './sessions.js';

/** Path of the WebSocket endpoint. */
export const RPC_PATH = '/rpc';
/** How long a socket may stay unauthenticated. */
export const AUTH_TIMEOUT_MS = 5_000;
/** Ping interval. */
export const HEARTBEAT_MS = 15_000;

/** A JSON-RPC error a handler throws on purpose. */
export class RpcError extends Error {
  public override readonly name = 'RpcError';
  public readonly code: number;
  public readonly data: AppRpcErrorData;

  public constructor(name: AppRpcErrorName, message: string, remediation?: string) {
    super(message);
    this.code = AppRpcErrorCode[name];
    this.data = { code: name, message, ...(remediation === undefined ? {} : { remediation }) };
  }
}

/** One authenticated socket. */
export interface RpcConnection {
  readonly id: number;
  readonly windowId: string;
  /** Sends a notification to this socket (dropped if it is closing). */
  notify(method: string, params: Record<string, unknown>): void;
  /** Called once when the socket closes. */
  onClose(listener: () => void): void;
}

/** What a handler is called with besides its params. */
export interface RpcCallContext {
  readonly windowId: string;
  readonly connection: RpcConnection;
}

/** One method: its params schema, its handler and its result schema. */
export interface RpcMethod<P = unknown, R = unknown> {
  readonly params: z.ZodType<P, z.ZodTypeDef, unknown>;
  readonly result: z.ZodType<R, z.ZodTypeDef, unknown>;
  readonly handler: (params: P, context: RpcCallContext) => R | Promise<R>;
}

/** Name → method. Methods are registered by the modules that own them. */
export class RpcMethodRegistry {
  private readonly methods = new Map<string, RpcMethod>();

  /** Registers a method; a second registration of one name throws. */
  public register<P, R>(name: string, method: RpcMethod<P, R>): this {
    if (this.methods.has(name)) throw new Error(`RPC method ${name} is already registered.`);
    this.methods.set(name, method as unknown as RpcMethod);
    return this;
  }

  public get(name: string): RpcMethod | undefined {
    return this.methods.get(name);
  }

  public names(): readonly string[] {
    return [...this.methods.keys()].sort();
  }
}

export interface RpcServerDeps {
  readonly sessions: SessionStore;
  readonly methods: RpcMethodRegistry;
  readonly buildId: () => string;
  readonly yantraVersion: string;
  readonly logger?: HostLogger;
  readonly now?: () => Date;
  readonly authTimeoutMs?: number;
  readonly heartbeatMs?: number;
}

type Socket = WebSocket & { yantraConnectionId?: number };

interface ConnectionState {
  readonly connection: RpcConnection;
  readonly socket: Socket;
  missedPongs: number;
}

function errorResponse(id: JsonRpcId, error: RpcError): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: error.code, message: error.message, data: error.data },
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'params'}: ${issue.message}`)
    .join('; ');
}

/** Writes a raw HTTP refusal on an upgrade socket and destroys it. */
function refuseUpgrade(socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  socket.destroy();
}

/** The WebSocket endpoint; see the module comment. */
export class RpcServer {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<number, ConnectionState>();
  private readonly logger: HostLogger;
  private readonly now: () => Date;
  private readonly authTimeoutMs: number;
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribeExpiry: () => void;
  private nextId = 1;

  public constructor(private readonly deps: RpcServerDeps) {
    this.logger = deps.logger ?? SILENT_HOST_LOGGER;
    this.now = deps.now ?? (() => new Date());
    this.authTimeoutMs = deps.authTimeoutMs ?? AUTH_TIMEOUT_MS;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_APP_RPC_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.heartbeat = setInterval(() => {
      this.beat();
    }, deps.heartbeatMs ?? HEARTBEAT_MS);
    this.heartbeat.unref();
    this.unsubscribeExpiry = deps.sessions.onExpire((windowId) => {
      this.closeWindow(windowId);
    });
    registerCoreMethods(deps.methods, deps);
  }

  /** Authenticated connections, optionally for one window. */
  public connectionsFor(windowId?: string): readonly RpcConnection[] {
    return [...this.connections.values()]
      .map((state) => state.connection)
      .filter((connection) => windowId === undefined || connection.windowId === windowId);
  }

  /** Sends a notification to every authenticated socket (or one window's). */
  public notify(method: string, params: Record<string, unknown>, windowId?: string): void {
    for (const connection of this.connectionsFor(windowId)) connection.notify(method, params);
  }

  /** Expires due sessions now (also run on every heartbeat). */
  public sweep(): void {
    this.deps.sessions.sweep();
  }

  /** The `upgrade` handler for {@link AppHost}. */
  public readonly handleUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    { port }: HostRouteContext,
  ): void => {
    const path = (req.url ?? '').split('?', 1)[0];
    const cookie = readSessionCookie(req);
    if (
      path !== RPC_PATH ||
      !hostMatches(req, port) ||
      !originMatches(req, port) ||
      !this.deps.sessions.cookieIsLive(cookie)
    ) {
      this.logger.warn({ reason: 'upgrade_refused' }, 'websocket upgrade refused');
      refuseUpgrade(socket);
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.accept(ws, cookie);
    });
  };

  /** Closes every socket and stops the heartbeat. */
  public close(): void {
    clearInterval(this.heartbeat);
    this.unsubscribeExpiry();
    for (const state of this.connections.values()) state.socket.terminate();
    this.connections.clear();
    this.wss.close();
  }

  private accept(ws: Socket, cookie: string | null): void {
    let authenticated = false;
    const timer = setTimeout(() => {
      if (!authenticated) ws.close(APP_RPC_CLOSE_UNAUTHORIZED);
    }, this.authTimeoutMs);
    timer.unref();
    ws.on('error', () => undefined);
    ws.once('close', () => {
      clearTimeout(timer);
    });
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      const window = isBinary ? null : this.authenticate(data, cookie);
      if (window === null) {
        ws.close(APP_RPC_CLOSE_UNAUTHORIZED);
        return;
      }
      authenticated = true;
      this.open(ws, window);
    });
  }

  private authenticate(data: RawData, cookie: string | null): string | null {
    let parsed: ReturnType<typeof AppRpcAuth.safeParse>;
    try {
      parsed = AppRpcAuth.safeParse(JSON.parse(rawText(data)) as unknown);
    } catch {
      return null;
    }
    if (!parsed.success) return null;
    return (
      this.deps.sessions.authenticate(cookie, parsed.data.params.window_capability)?.windowId ??
      null
    );
  }

  private open(ws: Socket, windowId: string): void {
    const id = this.nextId++;
    const closeListeners: (() => void)[] = [];
    const connection: RpcConnection = {
      id,
      windowId,
      notify: (method, params) => {
        this.send(ws, { jsonrpc: '2.0', method, params });
      },
      onClose: (listener) => {
        closeListeners.push(listener);
      },
    };
    const state: ConnectionState = { connection, socket: ws, missedPongs: 0 };
    this.connections.set(id, state);
    this.deps.sessions.socketOpened(windowId);
    ws.on('pong', () => {
      state.missedPongs = 0;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(1003);
        return;
      }
      void this.dispatch(rawText(data), connection).then((reply) => {
        if (reply !== null) this.send(ws, reply);
      });
    });
    ws.once('close', () => {
      this.connections.delete(id);
      this.deps.sessions.socketClosed(windowId);
      for (const listener of closeListeners) {
        try {
          listener();
        } catch (error) {
          this.logger.error({ err: errorName(error) }, 'close listener failed');
        }
      }
    });
    connection.notify('host.build', { build_id: this.deps.buildId() });
  }

  /**
   * Handles one incoming text message and returns what to send back (a
   * response, an array of responses, or null for notifications only).
   */
  public async dispatch(
    text: string,
    connection: RpcConnection,
  ): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return errorResponse(
        null,
        new RpcError(
          'parse_error',
          'The message is not valid JSON.',
          'Send one JSON-RPC 2.0 object.',
        ),
      );
    }
    if (Array.isArray(json)) {
      if (json.length === 0) {
        return errorResponse(null, new RpcError('invalid_request', 'The batch is empty.'));
      }
      const replies = await Promise.all(json.map((item) => this.dispatchOne(item, connection)));
      const kept = replies.filter((reply): reply is JsonRpcResponse => reply !== null);
      return kept.length > 0 ? kept : null;
    }
    return this.dispatchOne(json, connection);
  }

  private async dispatchOne(
    item: unknown,
    connection: RpcConnection,
  ): Promise<JsonRpcResponse | null> {
    const request = JsonRpcRequest.safeParse(item);
    if (!request.success) {
      const id = requestIdOf(item);
      return errorResponse(
        id,
        new RpcError(
          'invalid_request',
          'The message is not a JSON-RPC 2.0 request.',
          'Send {"jsonrpc":"2.0","method":…,"params":{…},"id":…}.',
        ),
      );
    }
    const { method: name, params, id } = request.data;
    const isNotification = id === undefined;
    const reply = (response: JsonRpcResponse): JsonRpcResponse | null =>
      isNotification ? null : response;
    const method = this.deps.methods.get(name);
    if (method === undefined) {
      return reply(
        errorResponse(
          id ?? null,
          new RpcError('method_not_found', `There is no method named ${name}.`),
        ),
      );
    }
    const parsedParams = method.params.safeParse(params ?? {});
    if (!parsedParams.success) {
      return reply(
        errorResponse(
          id ?? null,
          new RpcError(
            'invalid_params',
            `The parameters for ${name} are invalid: ${describeIssues(parsedParams.error)}.`,
            `Send the parameters ${name} expects, by name.`,
          ),
        ),
      );
    }
    try {
      const value = await method.handler(parsedParams.data, {
        windowId: connection.windowId,
        connection,
      });
      const result = method.result.safeParse(value);
      if (!result.success) {
        this.logger.error({ method: name }, 'rpc result failed validation');
        return reply(
          errorResponse(
            id ?? null,
            new RpcError('internal_error', `The host produced an invalid result for ${name}.`),
          ),
        );
      }
      return reply({ jsonrpc: '2.0', id: id ?? null, result: result.data });
    } catch (error) {
      if (error instanceof RpcError) return reply(errorResponse(id ?? null, error));
      this.logger.error({ method: name, err: errorName(error) }, 'rpc handler failed');
      return reply(
        errorResponse(
          id ?? null,
          new RpcError(
            'internal_error',
            `${name} failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
            'Try again; if it keeps failing, see host.log.',
          ),
        ),
      );
    }
  }

  private send(ws: WebSocket, value: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(value));
  }

  private beat(): void {
    this.sweep();
    for (const state of this.connections.values()) {
      if (state.missedPongs >= 2) {
        state.socket.terminate();
        continue;
      }
      state.missedPongs += 1;
      state.socket.ping();
    }
  }

  private closeWindow(windowId: string): void {
    for (const state of this.connections.values()) {
      if (state.connection.windowId === windowId) state.socket.close(APP_RPC_CLOSE_UNAUTHORIZED);
    }
  }
}

/** The methods every host serves: `host.hello` and the session codes. */
function registerCoreMethods(methods: RpcMethodRegistry, deps: RpcServerDeps): void {
  const now = deps.now ?? (() => new Date());
  methods.register('host.hello', {
    params: HostHelloParams,
    result: HostHelloResult,
    handler: () => ({
      build_id: deps.buildId(),
      channel_version: APP_CHANNEL_VERSION,
      yantra_version: deps.yantraVersion,
      server_time: now().toISOString(),
    }),
  });
  const windowCode = (_params: EmptyParams, { windowId }: RpcCallContext) => {
    const issued = deps.sessions.issueResumeCode(windowId);
    if (issued === null) {
      throw new RpcError(
        'unauthorized',
        'This window’s session has ended.',
        'Run `yantra ui` to open the app again.',
      );
    }
    return { code: issued.code, expires_at: new Date(issued.expiresAt).toISOString() };
  };
  methods.register('session.resume_code', {
    params: EmptyParams,
    result: SessionCodeResult,
    handler: windowCode,
  });
  // D17: the stale-asset reload navigates to `/#code=<code>` with a window-bound code.
  methods.register('session.launch_code', {
    params: EmptyParams,
    result: SessionCodeResult,
    handler: windowCode,
  });
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

function requestIdOf(item: unknown): JsonRpcId {
  if (item !== null && typeof item === 'object' && 'id' in item) {
    const { id } = item;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}
