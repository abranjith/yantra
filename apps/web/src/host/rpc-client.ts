/**
 * The app's JSON-RPC 2.0 client over the host WebSocket (FEAT-065 TASK-011).
 *
 * - Connects to `ws://127.0.0.1:<port>/rpc`, sends `auth` first, then
 *   `host.hello`; the connection counts as up once `host.hello` answers.
 * - Every request carries its own ID; requests in flight when the socket
 *   drops are rejected with {@link RpcDisconnectedError}.
 * - Reconnects with jittered exponential backoff (0.5 s to 10 s) and replays
 *   every subscription after each reconnect.
 * - Close code 4401, or five minutes without a connection (the host's grace
 *   period), means the session ended: no further reconnects.
 */

import type { HostHelloResult } from '@yantra/protocol';

import type { ConnectionStore } from './connection-store.js';

/** WebSocket close code: the session is no longer valid. */
export const CLOSE_UNAUTHORIZED = 4401;
/** How long the host keeps a disconnected window's session. */
export const SESSION_GRACE_MS = 5 * 60_000;
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 10_000;

/** The slice of the browser `WebSocket` the client uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Timer functions, injected for tests. */
export interface ClientTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A request was in flight when the socket closed. */
export class RpcDisconnectedError extends Error {
  public override readonly name = 'RpcDisconnectedError';
  public constructor(public readonly method: string) {
    super(`The connection to Yantra closed before ${method} answered.`);
  }
}

/** The host answered with a JSON-RPC error. */
export class RpcCallError extends Error {
  public override readonly name = 'RpcCallError';
  public constructor(
    public readonly method: string,
    public readonly code: number,
    message: string,
    public readonly reason: string,
    public readonly remediation: string | undefined,
  ) {
    super(message);
  }
}

/** The backoff before reconnect attempt `attempt` (0-based), given a random draw in [0, 1). */
export function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
  return Math.max(BACKOFF_MIN_MS, Math.round(ceiling * (0.5 + random * 0.5)));
}

export interface RpcClientDeps {
  readonly url: string;
  /** The current window capability, held in memory only. */
  readonly capability: () => string | null;
  readonly buildId: string;
  readonly channelVersion: number;
  readonly store: ConnectionStore;
  readonly createSocket?: (url: string) => SocketLike;
  readonly timers?: ClientTimers;
  readonly random?: () => number;
  readonly now?: () => number;
  /** Called after each successful `host.hello`. */
  readonly onHello?: (hello: HostHelloResult) => void;
}

interface Pending {
  readonly method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Subscription {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

const OPEN = 1;

/** See the module comment. */
export class RpcClient {
  private socket: SocketLike | null = null;
  private ready = false;
  private nextId = 1;
  private attempt = 0;
  private reconnectTimer: unknown = null;
  private disconnectedSince: number | null = null;
  private closed = false;
  private readonly pending = new Map<number, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly handlers = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private readonly timers: ClientTimers;
  private readonly random: () => number;
  private readonly now: () => number;

  public constructor(private readonly deps: RpcClientDeps) {
    this.timers = deps.timers ?? {
      setTimeout: (callback, ms) => window.setTimeout(callback, ms),
      clearTimeout: (handle) => {
        window.clearTimeout(handle as number);
      },
    };
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
  }

  /** Requests awaiting a response. */
  public get pendingCount(): number {
    return this.pending.size;
  }

  /** True once `host.hello` has answered on the current socket. */
  public get connected(): boolean {
    return this.ready;
  }

  /** Opens the socket (once; reconnects are automatic). */
  public connect(): void {
    if (this.closed || this.socket !== null) return;
    const capability = this.deps.capability();
    if (capability === null) {
      this.end();
      return;
    }
    const socket = (
      this.deps.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike)
    )(this.deps.url);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'auth',
          params: { window_capability: capability },
        }),
      );
      void this.handshake();
    };
    socket.onmessage = (event) => {
      this.receive(event.data);
    };
    socket.onclose = (event) => {
      this.dropped(socket, event.code);
    };
    socket.onerror = () => undefined;
  }

  /** Sends a request; rejects on an error response or a dropped socket. */
  public request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (socket?.readyState !== OPEN) {
      return Promise.reject(new RpcDisconnectedError(method));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    });
  }

  /**
   * Subscribes now (when connected) and again after every reconnect. Keyed
   * by method, so subscribing twice keeps one subscription.
   */
  public subscribe(method: string, params: Record<string, unknown> = {}): void {
    const existing = this.subscriptions.get(method);
    if (existing !== undefined && JSON.stringify(existing.params) === JSON.stringify(params))
      return;
    this.subscriptions.set(method, { method, params });
    if (this.ready) void this.request(method, params).catch(() => undefined);
  }

  /** Handles a notification method; returns the unsubscribe function. */
  public on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    let set = this.handlers.get(method);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Closes for good (the page is unloading or the session ended). */
  public close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) this.timers.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
  }

  private async handshake(): Promise<void> {
    try {
      const hello = await this.request<HostHelloResult>('host.hello', {
        build_id: this.deps.buildId,
        channel_version: this.deps.channelVersion,
      });
      if (hello.channel_version !== this.deps.channelVersion) {
        this.deps.store.set({ status: 'incompatible', hostVersion: hello.yantra_version });
        this.close();
        return;
      }
      this.ready = true;
      this.attempt = 0;
      this.disconnectedSince = null;
      this.deps.store.set({ status: 'connected' });
      for (const subscription of this.subscriptions.values()) {
        void this.request(subscription.method, subscription.params).catch(() => undefined);
      }
      this.deps.onHello?.(hello);
    } catch {
      // The socket closed or hello failed; `dropped` schedules the retry.
    }
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    for (const item of Array.isArray(message) ? (message as unknown[]) : [message]) {
      if (item === null || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.id === 'number' && this.pending.has(record.id)) {
        const pending = this.pending.get(record.id)!;
        this.pending.delete(record.id);
        const error = record.error as
          | { code?: number; message?: string; data?: { code?: string; remediation?: string } }
          | undefined;
        if (error !== undefined) {
          pending.reject(
            new RpcCallError(
              pending.method,
              error.code ?? -32603,
              error.message ?? 'The host refused the request.',
              error.data?.code ?? 'internal_error',
              error.data?.remediation,
            ),
          );
        } else {
          pending.resolve(record.result);
        }
        continue;
      }
      if (typeof record.method === 'string' && record.id === undefined) {
        const params =
          record.params !== null && typeof record.params === 'object'
            ? (record.params as Record<string, unknown>)
            : {};
        for (const handler of [...(this.handlers.get(record.method) ?? [])]) handler(params);
      }
    }
  }

  private dropped(socket: SocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.ready = false;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new RpcDisconnectedError(pending.method));
    }
    if (this.closed) return;
    const now = this.now();
    this.disconnectedSince ??= now;
    if (code === CLOSE_UNAUTHORIZED || now - this.disconnectedSince >= SESSION_GRACE_MS) {
      this.end();
      return;
    }
    const delay = backoffDelay(this.attempt, this.random());
    this.attempt += 1;
    this.deps.store.set({ status: 'disconnected', retryAt: now + delay });
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private end(): void {
    this.closed = true;
    this.deps.store.set({ status: 'session_ended' });
  }
}
