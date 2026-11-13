/**
 * A test client for the app host's `/rpc` endpoint: connects with any
 * cookie/Origin/Host, queues incoming messages, and records the close code.
 */

import { WebSocket, type ClientOptions } from 'ws';

export interface ConnectOptions {
  readonly cookie?: string | null;
  readonly origin?: string | null;
  readonly host?: string;
  readonly path?: string;
  readonly autoPong?: boolean;
}

export interface TestSocket {
  readonly ws: WebSocket;
  /** Resolves with the next message, parsed. Rejects after `timeoutMs`. */
  next(timeoutMs?: number): Promise<unknown>;
  /** Resolves with the next message whose `id` equals `id`. */
  reply(id: string | number, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Sends a value as JSON. */
  send(value: unknown): void;
  /** Sends a request and resolves with its response. */
  call(method: string, params?: unknown, id?: string | number): Promise<Record<string, unknown>>;
  /** Resolves with the close code. */
  readonly closed: Promise<number>;
  /** Every message received so far. */
  readonly received: unknown[];
}

let counter = 0;

/**
 * Opens a socket. Resolves once it is open, or rejects with the HTTP status of
 * a refused upgrade (`Error('unexpected-response:403')`).
 */
export function connect(port: number, options: ConnectOptions = {}): Promise<TestSocket> {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined && options.cookie !== null) {
    headers.cookie = `yantra_session=${options.cookie}`;
  }
  if (options.host !== undefined) headers.host = options.host;
  const clientOptions: ClientOptions = {
    headers,
    autoPong: options.autoPong ?? true,
    perMessageDeflate: false,
    ...(options.origin === null ? {} : { origin: options.origin ?? `http://127.0.0.1:${port}` }),
  };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? '/rpc'}`, clientOptions);
  const received: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  ws.on('message', (data) => {
    const value = JSON.parse(String(data)) as unknown;
    received.push(value);
    for (const waiter of waiters.splice(0)) waiter(value);
  });
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      resolve(code);
    });
  });
  // A reset after the host closes is reported through `closed`, never thrown.
  ws.on('error', () => undefined);
  const socket: TestSocket = {
    ws,
    received,
    closed,
    next: (timeoutMs = 2_000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('no message'));
        }, timeoutMs);
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      }),
    reply: async (id, timeoutMs = 2_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = received.find(
          (item) => typeof item === 'object' && item !== null && 'id' in item && item.id === id,
        );
        if (found !== undefined) return found as Record<string, unknown>;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`no reply to ${String(id)}`);
        await socket.next(left).catch(() => undefined);
      }
    },
    send: (value) => {
      ws.send(JSON.stringify(value));
    },
    call: (method, params = {}, id = `r${++counter}`) => {
      socket.send({ jsonrpc: '2.0', method, params, id });
      return socket.reply(id);
    },
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      resolve(socket);
    });
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`unexpected-response:${String(res.statusCode)}`));
    });
    ws.once('error', reject);
  });
}

/** Connects and authenticates; resolves after the `host.build` notification. */
export async function connectAuthenticated(
  port: number,
  cookie: string,
  capability: string,
): Promise<TestSocket> {
  const socket = await connect(port, { cookie });
  const first = socket.next();
  socket.send({ jsonrpc: '2.0', method: 'auth', params: { window_capability: capability } });
  await first;
  return socket;
}
