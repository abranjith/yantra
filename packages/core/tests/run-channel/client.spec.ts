// @no-llm
/**
 * `RunChannelClient.connect`: attached, live_unavailable, unreachable
 * (FEAT-064 TASK-005), over real sockets.
 */

import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunChannelClient } from '../../src/run-channel/client.js';
import { FrameDecoder, encodeJsonFrame } from '../../src/run-channel/frame-codec.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import { allocateSocketAddress } from '../../src/run-channel/socket-address.js';

import {
  TOKEN,
  cleanupSandbox,
  leaseFor,
  makeRunDir,
  sandboxHome,
  silentLogger,
} from './support.js';

const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  sandboxHome();
});

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  cleanupSandbox();
});

async function serve(): Promise<RunChannelServer> {
  const server = await RunChannelServer.listen({
    runId: 'r1',
    token: TOKEN,
    logger: silentLogger,
    builtInCapabilities: ['events'],
  });
  closers.push(() => server.close(0));
  return server;
}

/** A raw fake owner that records every byte and answers the first frame with `reply`. */
async function fakeOwner(reply: unknown | null): Promise<{
  address: Awaited<ReturnType<typeof allocateSocketAddress>>;
  received: () => unknown[];
}> {
  const address = await allocateSocketAddress();
  const frames: unknown[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    const decoder = new FrameDecoder();
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.kind === 'json') frames.push(frame.message);
        if (frames.length === 1 && reply !== null) socket.write(encodeJsonFrame(reply));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(address.address, resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return { address, received: () => frames };
}

function client(runDir = makeRunDir(), helloTimeoutMs?: number): RunChannelClient {
  const created = new RunChannelClient({
    clientKind: 'cli',
    runDir,
    logger: silentLogger,
    ...(helloTimeoutMs === undefined ? {} : { helloTimeoutMs }),
  });
  closers.push(() => {
    created.close();
    return Promise.resolve();
  });
  return created;
}

describe('@no-llm RunChannelClient.connect', () => {
  it('attaches with the negotiated version and capabilities', async () => {
    const server = await serve();
    const attaching = client();
    const result = await attaching.connect(leaseFor('r1', server.address));
    expect(result).toEqual({ state: 'attached', capabilities: ['events'], channelVersion: 1 });
    expect(attaching.getSnapshot()).toMatchObject({ state: 'attached', ownerVersion: '0.0.1' });
  });

  it('is unreachable with a wrong token (the owner says nothing and closes)', async () => {
    const server = await serve();
    const result = await client().connect(
      leaseFor('r1', server.address, { run_token: 'x'.repeat(43) }),
    );
    expect(result).toEqual({ state: 'unreachable' });
  });

  it('is unreachable when nothing listens at the address', async () => {
    const address = await allocateSocketAddress();
    expect(await client().connect(leaseFor('r1', address))).toEqual({ state: 'unreachable' });
  });

  it('is unreachable when the owner never answers hello', async () => {
    const owner = await fakeOwner(null);
    expect(await client(makeRunDir(), 100).connect(leaseFor('r1', owner.address))).toEqual({
      state: 'unreachable',
    });
  });

  it('reports a previous-version owner as live_unavailable and never sends cancel', async () => {
    const owner = await fakeOwner({
      type: 'hello_incompatible',
      supported: { min: 0, max: 0 },
      yantra_version: '0.0.9',
    });
    const attaching = client();
    const result = await attaching.connect(leaseFor('r1', owner.address));
    expect(result).toEqual({ state: 'live_unavailable', ownerVersion: '0.0.9' });
    expect(await attaching.cancel()).toBeNull();
    attaching.subscribe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.received().map((frame) => (frame as { type: string }).type)).toEqual(['hello']);
    expect(attaching.getSnapshot().state).toBe('live_unavailable');
  });

  it('sends the lease token and its client kind in hello', async () => {
    const owner = await fakeOwner(null);
    void client(makeRunDir(), 100).connect(leaseFor('r1', owner.address));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(owner.received()[0]).toEqual({
      type: 'hello',
      token: TOKEN,
      channel_version: 1,
      capabilities: ['events', 'cancel'],
      client_kind: 'cli',
    });
  });

  it('attaches through a real ownership session lease, which finish() then releases', async () => {
    const { RunOwnershipSession } = await import('../../src/run-ownership/ownership-session.js');
    const { readLease } = await import('../../src/run-ownership/lease-store.js');
    const runDir = makeRunDir();
    const session = await RunOwnershipSession.open({
      runDir,
      runId: 'r1',
      origin: 'terminal',
      executionClass: 'run',
      command: ['research'],
      identity: { pid: process.pid, startToken: 'test' },
    });
    const read = await readLease(runDir);
    if (read.kind !== 'lease') throw new Error('expected a lease');
    const attaching = client(runDir);
    const result = await attaching.connect(read.lease);
    expect(result.state).toBe('attached');
    await session.finish();
    expect(await readLease(runDir)).toEqual({ kind: 'absent' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(['disconnected', 'ended']).toContain(attaching.getSnapshot().state);
  });

  it('round-trips cancel to a registered handler', async () => {
    const server = await serve();
    server.register('cancel', 'cancel', (_request, connection) => {
      connection.send({ type: 'cancel_ack', already_cancelling: false, honored: false });
    });
    const attaching = client();
    await attaching.connect(leaseFor('r1', server.address));
    expect(await attaching.cancel()).toEqual({ alreadyCancelling: false, honored: false });
  });
});
