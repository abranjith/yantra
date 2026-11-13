// @no-llm
/**
 * The app's RPC client (FEAT-065 TASK-011): auth then hello, request IDs,
 * notifications, bounded jittered backoff, resubscribe and session end.
 */

import { describe, expect, it } from 'vitest';

import { ConnectionStore } from '../../src/host/connection-store.js';
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  RpcCallError,
  RpcClient,
  RpcDisconnectedError,
  SESSION_GRACE_MS,
  backoffDelay,
} from '../../src/host/rpc-client.js';
import { HELLO, ManualTimers, SocketFactory, flush } from '../support/fake-socket.js';

function setup(overrides: { capability?: string | null; now?: () => number } = {}) {
  const sockets = new SocketFactory();
  const timers = new ManualTimers();
  const store = new ConnectionStore();
  const hellos: unknown[] = [];
  const client = new RpcClient({
    url: 'ws://127.0.0.1:5000/rpc',
    capability: () => (overrides.capability === undefined ? 'CAP' : overrides.capability),
    buildId: 'build-1',
    channelVersion: 1,
    store,
    createSocket: sockets.create,
    timers,
    random: () => 0.5,
    now: overrides.now ?? (() => 0),
    onHello: (hello) => hellos.push(hello),
  });
  return { sockets, timers, store, client, hellos };
}

async function connect(env: ReturnType<typeof setup>): Promise<void> {
  env.client.connect();
  env.sockets.current.open();
  env.sockets.current.answer('host.hello', HELLO);
  await flush();
}

describe('handshake', () => {
  it('sends auth first, then host.hello with the page build, then reports connected', async () => {
    // Arrange
    const env = setup();

    // Act
    await connect(env);

    // Assert
    const [auth, hello] = env.sockets.current.sent;
    expect(auth).toEqual({ jsonrpc: '2.0', method: 'auth', params: { window_capability: 'CAP' } });
    expect(hello).toMatchObject({
      method: 'host.hello',
      params: { build_id: 'build-1', channel_version: 1 },
    });
    expect(env.store.getSnapshot()).toEqual({ status: 'connected' });
    expect(env.hellos).toEqual([HELLO]);
    expect(env.client.connected).toBe(true);
  });

  it('marks an incompatible host and stops', async () => {
    const env = setup();
    env.client.connect();
    env.sockets.current.open();
    env.sockets.current.answer('host.hello', {
      ...HELLO,
      channel_version: 2,
      yantra_version: '2.0.0',
    });
    await flush();
    expect(env.store.getSnapshot()).toEqual({ status: 'incompatible', hostVersion: '2.0.0' });
    expect(env.timers.scheduled).toEqual([]);
  });

  it('ends the session without connecting when there is no capability', () => {
    const env = setup({ capability: null });
    env.client.connect();
    expect(env.sockets.sockets).toEqual([]);
    expect(env.store.getSnapshot()).toEqual({ status: 'session_ended' });
  });
});

describe('requests', () => {
  it('gives each request its own ID and resolves by ID', async () => {
    const env = setup();
    await connect(env);
    const a = env.client.request<{ n: number }>('test.a');
    const b = env.client.request<{ n: number }>('test.b');
    const [ra, rb] = [env.sockets.current.last('test.a'), env.sockets.current.last('test.b')];
    expect(ra?.id).not.toBe(rb?.id);
    env.sockets.current.push({ jsonrpc: '2.0', id: rb?.id, result: { n: 2 } });
    env.sockets.current.push({ jsonrpc: '2.0', id: ra?.id, result: { n: 1 } });
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 2 });
  });

  it('rejects with a typed error carrying code and remediation', async () => {
    const env = setup();
    await connect(env);
    const pending = env.client.request('read.list');
    const id = env.sockets.current.last('read.list')?.id;
    env.sockets.current.push({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32002,
        message: 'busy',
        data: { code: 'busy', message: 'busy', remediation: 'Try again.' },
      },
    });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcCallError);
    expect(error).toMatchObject({ code: -32002, reason: 'busy', remediation: 'Try again.' });
  });

  it('rejects in-flight requests with RpcDisconnectedError when the socket drops', async () => {
    const env = setup();
    await connect(env);
    const pending = env.client.request('read.list');
    expect(env.client.pendingCount).toBe(1);
    env.sockets.current.serverClose(1006);
    await expect(pending).rejects.toBeInstanceOf(RpcDisconnectedError);
    expect(env.client.pendingCount).toBe(0);
  });

  it('rejects a request made while disconnected', async () => {
    const env = setup();
    await expect(env.client.request('x')).rejects.toBeInstanceOf(RpcDisconnectedError);
  });

  it('routes notifications to handlers, including in a batch', async () => {
    const env = setup();
    await connect(env);
    const got: unknown[] = [];
    const off = env.client.on('runs.changed', (params) => got.push(params));
    env.sockets.current.push({
      jsonrpc: '2.0',
      method: 'runs.changed',
      params: { run_ids: ['a'] },
    });
    env.sockets.current.push([
      { jsonrpc: '2.0', method: 'runs.changed', params: { run_ids: ['b'] } },
    ]);
    off();
    env.sockets.current.push({
      jsonrpc: '2.0',
      method: 'runs.changed',
      params: { run_ids: ['c'] },
    });
    expect(got).toEqual([{ run_ids: ['a'] }, { run_ids: ['b'] }]);
  });
});

describe('reconnect', () => {
  it('backs off with jitter between 0.5 s and 10 s', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      for (const random of [0, 0.5, 0.999]) {
        const delay = backoffDelay(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(1, 0.999)).toBeLessThanOrEqual(1_000);
    expect(backoffDelay(30, 0.999)).toBeGreaterThan(9_900);
    expect(backoffDelay(30, 0)).toBe(5_000);
  });

  it('grows the delay across consecutive failures and reports the countdown', async () => {
    const env = setup({ now: () => 1_000 });
    await connect(env);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      env.sockets.current.serverClose(1006);
      delays.push(env.timers.scheduled[0]!.ms);
      expect(env.store.getSnapshot()).toEqual({
        status: 'disconnected',
        retryAt: 1_000 + delays.at(-1)!,
      });
      env.timers.fire();
    }
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(Math.max(...delays)).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it('resubscribes after reconnecting, once per subscription', async () => {
    // Arrange
    const env = setup();
    await connect(env);
    env.client.subscribe('runs.subscribe');
    env.client.subscribe('runs.subscribe');
    const first = env.sockets.current;
    expect(first.sent.filter((m) => m.method === 'runs.subscribe')).toHaveLength(1);

    // Act: the socket drops, the retry fires, the new socket handshakes.
    first.serverClose(1006);
    env.timers.fire();
    env.sockets.current.open();
    env.sockets.current.answer('host.hello', HELLO);
    await flush();

    // Assert
    const second = env.sockets.current;
    expect(second).not.toBe(first);
    const order = second.sent.map((message) => message.method);
    expect(order).toEqual(['auth', 'host.hello', 'runs.subscribe']);
  });

  it('resets the backoff after a successful reconnect', async () => {
    const env = setup();
    await connect(env);
    env.sockets.current.serverClose(1006);
    env.timers.fire();
    env.sockets.current.serverClose(1006);
    const second = env.timers.scheduled[0]!.ms;
    env.timers.fire();
    env.sockets.current.open();
    env.sockets.current.answer('host.hello', HELLO);
    await flush();
    env.sockets.current.serverClose(1006);
    expect(env.timers.scheduled[0]!.ms).toBeLessThan(second);
  });
});

describe('session end', () => {
  it('stops on close code 4401', async () => {
    const env = setup();
    await connect(env);
    env.sockets.current.serverClose(4401);
    expect(env.store.getSnapshot()).toEqual({ status: 'session_ended' });
    expect(env.timers.scheduled).toEqual([]);
  });

  it('stops once disconnected for the host grace period', async () => {
    let now = 0;
    const env = setup({ now: () => now });
    await connect(env);
    env.sockets.current.serverClose(1006);
    now = SESSION_GRACE_MS;
    env.timers.fire();
    env.sockets.current.serverClose(1006);
    expect(env.store.getSnapshot()).toEqual({ status: 'session_ended' });
  });

  it('stays ended even if a later state arrives', () => {
    const store = new ConnectionStore();
    store.set({ status: 'session_ended' });
    store.set({ status: 'connected' });
    expect(store.getSnapshot()).toEqual({ status: 'session_ended' });
  });
});
