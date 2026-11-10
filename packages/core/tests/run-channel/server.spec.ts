// @no-llm
/**
 * The run socket: token-first authentication and the version and capability
 * handshake (FEAT-064 TASK-005), over real sockets (a named pipe on Windows).
 */

import { chmodSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { FRAME_TYPE_JSON, MAX_HELLO_FRAME_BYTES } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { socketsRoot } from '../../src/browser/paths.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import {
  allocateSocketAddress,
  ensureSocketsRoot,
  removeStaleSocket,
} from '../../src/run-channel/socket-address.js';

import {
  ManualTimers,
  RawPeer,
  TOKEN,
  capturingLogger,
  cleanupSandbox,
  sandboxHome,
  silentLogger,
  until,
} from './support.js';

const servers: RunChannelServer[] = [];

beforeEach(() => {
  sandboxHome();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close(0)));
  cleanupSandbox();
});

async function serve(
  options: Partial<Parameters<typeof RunChannelServer.listen>[0]> = {},
): Promise<RunChannelServer> {
  const server = await RunChannelServer.listen({
    runId: 'r1',
    token: TOKEN,
    logger: silentLogger,
    ...options,
  });
  servers.push(server);
  return server;
}

function header(type: number, length: number): Buffer {
  const bytes = Buffer.alloc(5);
  bytes.writeUInt8(type, 0);
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

describe('@no-llm RunChannelServer: unauthenticated clients get nothing', () => {
  it('closes a client that sends no hello before the deadline, having written 0 bytes', async () => {
    const timers = new ManualTimers();
    const server = await serve({ timers });
    const peer = await RawPeer.open(server.address);
    await until(() => timers.elapsed === 0); // connection accepted
    await new Promise((resolve) => setTimeout(resolve, 20));
    timers.advance(4_999);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peer.socket.destroyed).toBe(false);
    timers.advance(1);
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });

  it.each([
    [
      'a wrong token of the same length',
      { token: `${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}` },
    ],
    ['a token of a different length', { token: `${TOKEN}x` }],
    ['an empty-ish short token', { token: 't' }],
  ])('closes on %s, having written 0 bytes', async (_label, overrides) => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello(overrides);
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });

  it('closes on a first frame that is not hello, having written 0 bytes', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.sendJson({ type: 'subscribe', from_seq: 0 });
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });

  it('closes on a 17 KiB first frame from its header alone', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.write(header(FRAME_TYPE_JSON, MAX_HELLO_FRAME_BYTES + 1024));
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });

  it('closes on a garbage type byte', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.write(header(0x7f, 2));
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });

  it('closes on malformed JSON in the hello frame', async () => {
    const peer = await RawPeer.open((await serve()).address);
    const payload = Buffer.from('{"type":"hello",', 'utf8');
    peer.write(Buffer.concat([header(FRAME_TYPE_JSON, payload.length), payload]));
    await peer.closed;
    expect(peer.bytes).toBe(0);
  });
});

describe('@no-llm RunChannelServer: handshake', () => {
  it('answers a valid hello with hello_ok and the capability intersection', async () => {
    const server = await serve({ builtInCapabilities: ['events'] });
    server.register('cancel', 'cancel', () => undefined);
    const peer = await RawPeer.open(server.address);
    peer.hello({ capabilities: ['events', 'cancel', 'frames'] });
    await peer.waitForFrames(1);
    expect(peer.messages()).toEqual([
      {
        type: 'hello_ok',
        channel_version: 1,
        supported: { min: 1, max: 1 },
        capabilities: ['events', 'cancel'],
        run_id: 'r1',
      },
    ]);
    await until(() => server.connectionCount === 1);
  });

  it('accepts a hello delivered one byte at a time', async () => {
    const peer = await RawPeer.open((await serve()).address);
    const { encodeJsonFrame } = await import('../../src/run-channel/frame-codec.js');
    const frame = encodeJsonFrame({
      type: 'hello',
      token: TOKEN,
      channel_version: 1,
      capabilities: [],
      client_kind: 'test',
    });
    for (const byte of frame) {
      peer.write(Uint8Array.of(byte));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await peer.waitForFrames(1);
    expect((peer.messages()[0] as { type: string }).type).toBe('hello_ok');
  });

  it('negotiates version 1 with a newer client', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello({ channel_version: 2 });
    await peer.waitForFrames(1);
    expect(peer.messages()[0]).toMatchObject({ type: 'hello_ok', channel_version: 1 });
  });

  it('answers a client below the supported range with hello_incompatible, then closes', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello({ channel_version: 0 });
    await peer.closed;
    expect(peer.messages()).toEqual([
      {
        type: 'hello_incompatible',
        supported: { min: 1, max: 1 },
        yantra_version: expect.any(String),
      },
    ]);
  });

  it('answers an unregistered type with error{unsupported} and keeps the connection', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello();
    await peer.waitForFrames(1);
    peer.sendJson({ type: 'intervention.answer', intervention_id: 'c1', decision: 'grant' });
    await peer.waitForFrames(2);
    peer.sendJson({ type: 'ping' });
    await peer.waitForFrames(3);
    expect(peer.messages().slice(1)).toEqual([
      { type: 'error', code: 'unsupported', message: 'intervention.answer' },
      { type: 'heartbeat', at: expect.any(String) },
    ]);
    expect(peer.socket.destroyed).toBe(false);
  });

  it('answers a malformed known message with error{bad_request}', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello();
    await peer.waitForFrames(1);
    peer.sendJson({ type: 'subscribe', from_seq: -1 });
    await peer.waitForFrames(2);
    expect(peer.messages()[1]).toEqual({
      type: 'error',
      code: 'bad_request',
      message: 'subscribe',
    });
  });

  it('dispatches a registered type to its handler with the connection', async () => {
    const server = await serve();
    server.register('cancel', 'cancel', (_request, connection) => {
      connection.send({ type: 'cancel_ack', already_cancelling: false, honored: true });
    });
    const peer = await RawPeer.open(server.address);
    peer.hello();
    await peer.waitForFrames(1);
    peer.sendJson({ type: 'cancel' });
    await peer.waitForFrames(2);
    expect(peer.messages()[1]).toEqual({
      type: 'cancel_ack',
      already_cancelling: false,
      honored: true,
    });
  });

  it('refuses to register a type the server answers itself', async () => {
    const server = await serve();
    expect(() => {
      server.register('subscribe', null, () => undefined);
    }).toThrow();
  });

  it('closes on malformed JSON after authentication', async () => {
    const peer = await RawPeer.open((await serve()).address);
    peer.hello();
    await peer.waitForFrames(1);
    const payload = Buffer.from('{oops', 'utf8');
    peer.write(Buffer.concat([header(FRAME_TYPE_JSON, payload.length), payload]));
    await peer.closed;
  });
});

describe('@no-llm RunChannelServer: logging and close', () => {
  it('logs attach and detach without ever logging the token or address', async () => {
    const { logger, lines } = capturingLogger();
    const server = await serve({ logger });
    const peer = await RawPeer.open(server.address);
    peer.hello({ client_kind: 'host' });
    await peer.waitForFrames(1);
    const wrong = await RawPeer.open(server.address);
    wrong.hello({ token: 'canary-not-the-token' });
    await wrong.closed;
    peer.destroy();
    await until(() => lines.some((line) => line.includes('channel_detached')));
    const all = lines.join('\n');
    expect(all).toContain('"client_kind":"host"');
    expect(all).toContain('duration_ms');
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('canary-not-the-token');
    expect(all).not.toContain(server.address.address);
  });

  it('ends authenticated connections and destroys pending ones on close', async () => {
    const server = await serve();
    const attached = await RawPeer.open(server.address);
    attached.hello();
    await attached.waitForFrames(1);
    const pending = await RawPeer.open(server.address);
    await server.close(1_000);
    await Promise.all([attached.closed, pending.closed]);
    expect(pending.bytes).toBe(0);
    await expect(RawPeer.open(server.address)).rejects.toThrow();
  });

  it('destroys a connection that does not close within the drain window', async () => {
    const server = await serve();
    const attached = await RawPeer.open(server.address);
    // A half-open peer never ends its own side, so only the drain timeout frees it.
    attached.socket.allowHalfOpen = true;
    const ended = new Promise<void>((resolve) => attached.socket.once('end', () => resolve()));
    attached.hello();
    await attached.waitForFrames(1);
    const started = Date.now();
    await server.close(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    await ended;
    attached.destroy();
  });
});

describe('@no-llm run socket addresses', () => {
  it('allocates an unguessable address matching the lease schema', async () => {
    const { RunSocketAddress } = await import('@yantra/protocol');
    const a = await allocateSocketAddress();
    const b = await allocateSocketAddress();
    expect(RunSocketAddress.safeParse(a).success).toBe(true);
    expect(a.address).not.toBe(b.address);
    expect(a.kind).toBe(process.platform === 'win32' ? 'pipe' : 'unix');
  });

  it('never removes a socket path outside the sockets root', async () => {
    expect(await removeStaleSocket({ kind: 'unix', address: `/etc/${'a'.repeat(24)}.sock` })).toBe(
      false,
    );
    expect(
      await removeStaleSocket({ kind: 'pipe', address: `\\\\.\\pipe\\yantra-${'a'.repeat(32)}` }),
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('creates the sockets root 0700', async () => {
    const root = await ensureSocketsRoot();
    const { statSync } = await import('node:fs');
    expect(statSync(root).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a sockets root with group-write bits, without repairing it',
    async () => {
      const root = socketsRoot();
      mkdirSync(root, { recursive: true });
      chmodSync(root, 0o770);
      await expect(ensureSocketsRoot()).rejects.toMatchObject({
        code: 'RUN_OWNERSHIP_SOCKET_DIR_UNSAFE',
      });
      const { statSync } = await import('node:fs');
      expect(statSync(root).mode & 0o777).toBe(0o770);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a symlinked sockets root', async () => {
    const root = socketsRoot();
    const target = join(root, '..', 'elsewhere');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, root);
    await expect(ensureSocketsRoot()).rejects.toMatchObject({
      code: 'RUN_OWNERSHIP_SOCKET_DIR_UNSAFE',
    });
  });
  // Windows: pipes have no directory; their 128-bit random names are the protection.
});
