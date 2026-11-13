// @no-llm
/**
 * The app's WebSocket JSON-RPC endpoint (FEAT-065 TASK-004): upgrade checks,
 * `auth`, limits, the dispatcher and the build-ID handshake.
 */

import { HostHelloResult } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppHost } from '../../../src/ui/host/host.js';
import { RpcError, RpcMethodRegistry, RpcServer } from '../../../src/ui/host/rpc-server.js';
import { ABSOLUTE_TTL_MS, SessionStore, type SessionGrant } from '../../../src/ui/host/sessions.js';

import { connect, connectAuthenticated } from './rpc-support.js';
import { cleanupTempDirs, makeWebBuild } from './support.js';

const START = Date.parse('2026-11-11T10:00:00.000Z');

let clockValue: number;
let sessions: SessionStore;
let methods: RpcMethodRegistry;
let rpc: RpcServer;
let host: AppHost;
let port: number;

function grant(): SessionGrant {
  return sessions.exchange(sessions.issueLaunchCode().code)!;
}

beforeEach(async () => {
  clockValue = START;
  sessions = new SessionStore({ now: () => clockValue });
  methods = new RpcMethodRegistry()
    .register('test.echo', {
      params: z.object({ value: z.string() }).strict(),
      result: z.object({ value: z.string() }).strict(),
      handler: ({ value }) => ({ value }),
    })
    .register('test.busy', {
      params: z.object({}).strict(),
      result: z.unknown(),
      handler: () => {
        throw new RpcError('busy', 'The queue is busy.', 'Try again.');
      },
    })
    .register('test.crash', {
      params: z.object({}).strict(),
      result: z.unknown(),
      handler: () => {
        throw new Error('kaboom');
      },
    })
    .register('test.bad_result', {
      params: z.object({}).strict(),
      result: z.object({ ok: z.literal(true) }),
      handler: () => ({ ok: false }),
    })
    .register('test.window', {
      params: z.object({}).strict(),
      result: z.object({ window_id: z.string() }),
      handler: (_params, { windowId }) => ({ window_id: windowId }),
    });
  rpc = new RpcServer({
    sessions,
    methods,
    buildId: () => 'build-rpc',
    yantraVersion: '9.9.9',
    now: () => new Date(clockValue),
    authTimeoutMs: 150,
    heartbeatMs: 60_000,
  });
  host = new AppHost({ assetsRoot: makeWebBuild(), upgrade: rpc.handleUpgrade });
  ({ port } = await host.start());
});

afterEach(async () => {
  rpc.close();
  await host.stop();
  cleanupTempDirs();
});

describe('upgrade', () => {
  it('is refused without a cookie', async () => {
    await expect(connect(port)).rejects.toThrow('unexpected-response:403');
  });

  it('is refused with an unknown cookie', async () => {
    await expect(connect(port, { cookie: 'forged' })).rejects.toThrow('unexpected-response:403');
  });

  it('is refused from a foreign Origin', async () => {
    const { cookie } = grant();
    await expect(connect(port, { cookie, origin: 'http://127.0.0.1:1' })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('is refused without an Origin', async () => {
    const { cookie } = grant();
    await expect(connect(port, { cookie, origin: null })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('is refused under a rebinding Host', async () => {
    const { cookie } = grant();
    await expect(connect(port, { cookie, host: `evil.example:${port}` })).rejects.toThrow(
      'unexpected-response:403',
    );
  });

  it('is refused on any path but /rpc', async () => {
    const { cookie } = grant();
    await expect(connect(port, { cookie, path: '/other' })).rejects.toThrow(
      'unexpected-response:403',
    );
  });
});

describe('auth', () => {
  it('accepts the cookie’s own capability and announces the build', async () => {
    // Arrange
    const session = grant();
    const socket = await connect(port, { cookie: session.cookie });
    const first = socket.next();

    // Act
    socket.send({
      jsonrpc: '2.0',
      method: 'auth',
      params: { window_capability: session.windowCapability },
    });

    // Assert
    expect(await first).toEqual({
      jsonrpc: '2.0',
      method: 'host.build',
      params: { build_id: 'build-rpc' },
    });
    expect(sessions.connectedWindows().map((window) => window.windowId)).toEqual([
      session.windowId,
    ]);
    socket.ws.close();
  });

  it('closes 4401 with no reply when the first message is not auth', async () => {
    const { cookie } = grant();
    const socket = await connect(port, { cookie });
    socket.send({ jsonrpc: '2.0', method: 'host.hello', params: {}, id: 1 });
    expect(await socket.closed).toBe(4401);
    expect(socket.received).toEqual([]);
  });

  it('closes 4401 on the wrong capability', async () => {
    const { cookie } = grant();
    const socket = await connect(port, { cookie });
    socket.send({ jsonrpc: '2.0', method: 'auth', params: { window_capability: 'wrong' } });
    expect(await socket.closed).toBe(4401);
    expect(socket.received).toEqual([]);
  });

  it("refuses window A's cookie with window B's capability", async () => {
    const a = grant();
    const b = grant();
    const socket = await connect(port, { cookie: a.cookie });
    socket.send({
      jsonrpc: '2.0',
      method: 'auth',
      params: { window_capability: b.windowCapability },
    });
    expect(await socket.closed).toBe(4401);
  });

  it('closes 4401 when nothing arrives within the auth timeout', async () => {
    const { cookie } = grant();
    const socket = await connect(port, { cookie });
    expect(await socket.closed).toBe(4401);
  });

  it('closes 4401 on a non-JSON first message', async () => {
    const { cookie } = grant();
    const socket = await connect(port, { cookie });
    socket.ws.send('not json');
    expect(await socket.closed).toBe(4401);
  });

  it('frees the window’s socket count on close', async () => {
    const session = grant();
    const socket = await connectAuthenticated(port, session.cookie, session.windowCapability);
    socket.ws.close();
    await socket.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessions.connectedWindows()).toEqual([]);
  });
});

describe('limits', () => {
  it('closes the socket on a frame over 1 MiB', async () => {
    const session = grant();
    const socket = await connectAuthenticated(port, session.cookie, session.windowCapability);
    socket.ws.send('x'.repeat(1_048_577));
    expect(await socket.closed).toBe(1009);
  });

  it('closes an expired capability’s open socket with 4401', async () => {
    const session = grant();
    const socket = await connectAuthenticated(port, session.cookie, session.windowCapability);
    clockValue += ABSOLUTE_TTL_MS;
    rpc.sweep();
    expect(await socket.closed).toBe(4401);
  });

  it('terminates a socket that misses two pongs', async () => {
    // Arrange: a server pinging every 40 ms and a client that never answers.
    rpc.close();
    await host.stop();
    rpc = new RpcServer({
      sessions,
      methods: new RpcMethodRegistry(),
      buildId: () => 'b',
      yantraVersion: '1',
      heartbeatMs: 40,
    });
    host = new AppHost({ assetsRoot: makeWebBuild(), upgrade: rpc.handleUpgrade });
    ({ port } = await host.start());
    const session = grant();
    const socket = await connect(port, { cookie: session.cookie, autoPong: false });
    const first = socket.next();
    socket.send({
      jsonrpc: '2.0',
      method: 'auth',
      params: { window_capability: session.windowCapability },
    });
    await first;

    // Act / Assert
    expect(await socket.closed).toBe(1006);
  });
});

describe('dispatcher', () => {
  let socket: Awaited<ReturnType<typeof connectAuthenticated>>;

  beforeEach(async () => {
    const session = grant();
    socket = await connectAuthenticated(port, session.cookie, session.windowCapability);
  });

  afterEach(() => {
    socket.ws.close();
  });

  it('answers host.hello with the host build', async () => {
    const reply = await socket.call('host.hello', { build_id: 'stale', channel_version: 1 });
    expect(HostHelloResult.parse(reply.result)).toEqual({
      build_id: 'build-rpc',
      channel_version: 1,
      yantra_version: '9.9.9',
      server_time: new Date(START).toISOString(),
    });
  });

  it.each([
    ['a string id', 'abc-123'],
    ['a number id', 42],
    ['a zero id', 0],
  ])('echoes %s unchanged', async (_label, id) => {
    const reply = await socket.call('test.echo', { value: 'v' }, id);
    expect(reply).toEqual({ jsonrpc: '2.0', id, result: { value: 'v' } });
  });

  it('answers an unknown method with -32601', async () => {
    const reply = await socket.call('nope.nothing');
    expect(reply.error).toMatchObject({ code: -32601, data: { code: 'method_not_found' } });
  });

  it('answers bad params with -32602 and a remediation', async () => {
    const reply = await socket.call('test.echo', { value: 3 });
    expect(reply.error).toMatchObject({
      code: -32602,
      data: {
        code: 'invalid_params',
        remediation: 'Send the parameters test.echo expects, by name.',
      },
    });
    expect((reply.error as { message: string }).message).toContain('value');
  });

  it('refuses positional params', async () => {
    const reply = await socket.call('test.echo', ['v']);
    expect(reply.error).toMatchObject({ code: -32602 });
  });

  it('answers invalid JSON with -32700 and a null id', async () => {
    const next = socket.next();
    socket.ws.send('{oops');
    expect(await next).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it('answers a non-request with -32600, keeping its id', async () => {
    socket.send({ jsonrpc: '1.0', method: 'x', id: 7 });
    expect(await socket.reply(7)).toMatchObject({ error: { code: -32600 } });
  });

  it('answers each batch item, omitting notifications', async () => {
    const next = socket.next();
    socket.send([
      { jsonrpc: '2.0', method: 'test.echo', params: { value: 'a' }, id: 1 },
      { jsonrpc: '2.0', method: 'test.echo', params: { value: 'b' } },
      { jsonrpc: '2.0', method: 'nope', id: 2 },
      { bad: true },
    ]);
    const replies = (await next) as Record<string, unknown>[];
    expect(replies).toHaveLength(3);
    expect(replies[0]).toEqual({ jsonrpc: '2.0', id: 1, result: { value: 'a' } });
    expect(replies[1]).toMatchObject({ id: 2, error: { code: -32601 } });
    expect(replies[2]).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('answers an empty batch with -32600', async () => {
    const next = socket.next();
    socket.send([]);
    expect(await next).toMatchObject({ error: { code: -32600 } });
  });

  it('sends nothing for a notification', async () => {
    socket.send({ jsonrpc: '2.0', method: 'test.echo', params: { value: 'a' } });
    await expect(socket.next(200)).rejects.toThrow('no message');
  });

  it('passes an RpcError through with its app code and remediation', async () => {
    const reply = await socket.call('test.busy');
    expect(reply.error).toEqual({
      code: -32002,
      message: 'The queue is busy.',
      data: { code: 'busy', message: 'The queue is busy.', remediation: 'Try again.' },
    });
  });

  it('turns an unexpected failure into -32603 without crashing the host', async () => {
    const reply = await socket.call('test.crash');
    expect(reply.error).toMatchObject({ code: -32603, data: { code: 'internal_error' } });
    expect(await socket.call('test.echo', { value: 'still up' })).toMatchObject({
      result: { value: 'still up' },
    });
  });

  it('refuses a result that fails its schema', async () => {
    const reply = await socket.call('test.bad_result');
    expect(reply.error).toMatchObject({ code: -32603 });
  });

  it('gives handlers the authenticated window', async () => {
    const reply = await socket.call('test.window');
    expect((reply.result as { window_id: string }).window_id).toBe(
      rpc.connectionsFor()[0]?.windowId,
    );
  });

  it('issues a window-bound resume code that exchanges for the same window', async () => {
    const reply = await socket.call('session.resume_code');
    const { code } = reply.result as { code: string };
    const windowId = rpc.connectionsFor()[0]?.windowId;
    expect(sessions.exchange(code)?.windowId).toBe(windowId);
  });

  it('refuses a second registration of one method name', () => {
    expect(() =>
      methods.register('test.echo', {
        params: z.object({}),
        result: z.unknown(),
        handler: () => 1,
      }),
    ).toThrow(/already registered/);
  });
});

describe('notifications', () => {
  it('reach every socket of one window, and only that window', async () => {
    const a = grant();
    const b = grant();
    const socketA = await connectAuthenticated(port, a.cookie, a.windowCapability);
    const socketB = await connectAuthenticated(port, b.cookie, b.windowCapability);
    const nextA = socketA.next();

    rpc.notify('runs.changed', { run_ids: ['r1'] }, a.windowId);

    expect(await nextA).toEqual({
      jsonrpc: '2.0',
      method: 'runs.changed',
      params: { run_ids: ['r1'] },
    });
    await expect(socketB.next(150)).rejects.toThrow('no message');
    socketA.ws.close();
    socketB.ws.close();
  });
});
