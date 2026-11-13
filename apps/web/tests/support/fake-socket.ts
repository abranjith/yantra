/**
 * A scripted WebSocket and stepped timers for the app's host-client tests.
 */

import type { ClientTimers, SocketLike } from '../../src/host/rpc-client.js';

/** A socket the test drives: open it, answer requests, close it. */
export class FakeSocket implements SocketLike {
  public readyState = 0;
  public readonly sent: Record<string, unknown>[] = [];
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onclose: ((event: { readonly code: number }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;

  public constructor(public readonly url: string) {}

  public send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  public close(code = 1000): void {
    this.serverClose(code);
  }

  /** The server accepts the connection. */
  public open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  /** The server sends a message. */
  public push(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  /** The connection closes with `code`. */
  public serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** The last request sent for `method`. */
  public last(method: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((message) => message.method === method);
  }

  /** Answers the last `method` request with `result`. */
  public answer(method: string, result: unknown): void {
    const request = this.last(method);
    if (request === undefined) throw new Error(`no ${method} request`);
    this.push({ jsonrpc: '2.0', id: request.id, result });
  }
}

/** Collects every socket a client creates. */
export class SocketFactory {
  public readonly sockets: FakeSocket[] = [];
  public readonly create = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    this.sockets.push(socket);
    return socket;
  };
  public get current(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    return socket;
  }
}

/** Timers the test fires by hand. */
export class ManualTimers implements ClientTimers {
  public readonly scheduled: { id: number; ms: number; callback: () => void }[] = [];
  private next = 1;

  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.scheduled.push({ id, ms, callback });
    return id;
  }

  public clearTimeout(handle: unknown): void {
    const index = this.scheduled.findIndex((timer) => timer.id === handle);
    if (index !== -1) this.scheduled.splice(index, 1);
  }

  /** Runs the oldest scheduled timer. */
  public fire(): void {
    const timer = this.scheduled.shift();
    if (timer === undefined) throw new Error('no timer');
    timer.callback();
  }
}

export const HELLO = {
  build_id: 'build-1',
  channel_version: 1,
  yantra_version: '1.0.0',
  server_time: '2026-11-11T10:00:00.000Z',
};

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
