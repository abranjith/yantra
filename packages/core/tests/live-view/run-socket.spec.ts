// @no-llm
/**
 * FEAT-069 TASK-008: the live view on a real run socket (named pipe on
 * Windows, Unix socket elsewhere), with the real hub over a fake capture.
 */
import { FRAMES_CAPABILITY, MAX_SCREENCAST_FRAME_BYTES } from '@yantra/protocol';
import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterEach, describe, expect, it } from 'vitest';

import { ScreenProtection } from '../../src/browser/screen-protection.js';
import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';
import { LiveViewHub } from '../../src/live-view/live-view-hub.js';
import { serveLiveViewOnRunSocket } from '../../src/live-view/run-socket.js';
import type { ScreencastSourceOptions } from '../../src/live-view/screencast-source.js';
import { TaskPageEvents, type TaskPageSource } from '../../src/live-view/task-page-source.js';
import { RunChannelClient } from '../../src/run-channel/client.js';
import { OutboundQueues } from '../../src/run-channel/outbound-queues.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import { RawPeer, TOKEN, leaseFor, makeRunDir, silentLogger } from '../run-channel/support.js';

const servers: RunChannelServer[] = [];
const peers: RawPeer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.destroy();
  await Promise.all(servers.splice(0).map((server) => server.close(0)));
});

function source(): TaskPageSource & { latch: SensitiveScreenLatch } {
  const latch = new SensitiveScreenLatch();
  const events = new TaskPageEvents(() => undefined);
  // One stable page object, as the real sources return.
  const page = { page: {} as PuppeteerPage, headless: true };
  return {
    latch,
    screenProtection: new ScreenProtection(latch),
    current: () => page,
    topLevelEpoch: () => 0,
    subscribe: (listener) => events.subscribe(listener),
  };
}

async function setup() {
  let now = 1_000_000;
  const captures: { options: ScreencastSourceOptions; stopped: boolean }[] = [];
  const hub = new LiveViewHub({
    clock: () => now,
    readPage: () => Promise.resolve({ host: 'a.test', title: 'A' }),
    installGuard: (_page, onFocus) => {
      onFocus('clear');
      return Promise.resolve({ dispose: () => Promise.resolve() });
    },
    startCapture: (options) => {
      const capture = { options, stopped: false };
      captures.push(capture);
      return Promise.resolve({
        stop: () => {
          capture.stopped = true;
          return Promise.resolve();
        },
      });
    },
  });
  const page = source();
  hub.attach(page);
  const server = await RunChannelServer.listen({ runId: 'r1', token: TOKEN, logger: silentLogger });
  servers.push(server);
  serveLiveViewOnRunSocket(
    {
      registerChannelHandler: (type, capability, handler) =>
        server.register(type, capability, handler),
    },
    hub,
  );
  const running = () => captures.filter((capture) => !capture.stopped);
  return {
    hub,
    server,
    page,
    captures,
    running,
    advance: (ms: number) => (now += ms),
    emit(bytes = 32): void {
      now += 10;
      const jpeg = new Uint8Array(bytes);
      jpeg[0] = 0xff;
      jpeg[1] = 0xd8;
      running().at(-1)!.options.onFrame({ jpeg, capturedAtMs: now, width: 10, height: 10 });
    },
  };
}

async function peer(
  server: RunChannelServer,
  capabilities: readonly string[] = ['events', FRAMES_CAPABILITY],
): Promise<RawPeer> {
  const opened = await RawPeer.open(server.address);
  peers.push(opened);
  opened.hello({ capabilities });
  await opened.waitForFrames(1);
  return opened;
}

const screencasts = (p: RawPeer) => p.frames.filter((frame) => frame.kind === 'screencast');
const typed = (p: RawPeer, type: string) =>
  p.messages().filter((message) => (message as { type?: string }).type === type);

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('@no-llm live view on the run socket', () => {
  it('advertises frames/1 and sends nothing until frames.start', async () => {
    const { server, captures } = await setup();
    const client = await peer(server);
    expect(client.messages()[0]).toMatchObject({
      type: 'hello_ok',
      capabilities: expect.arrayContaining([FRAMES_CAPABILITY]) as unknown,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(captures).toHaveLength(0);
    expect(screencasts(client)).toHaveLength(0);
  });

  it('streams type-0x02 frames after frames.start, one in flight until acked', async () => {
    const { server, hub, emit } = await setup();
    const client = await peer(server);
    client.sendJson({ type: 'frames.start', max_width: 640, max_height: 400 });
    await until(() => hub.capturing);
    emit();
    emit();
    await until(() => screencasts(client).length === 1);
    expect(typed(client, 'frames.state').at(-1)).toMatchObject({ state: 'live' });
    const first = screencasts(client)[0] as { meta: { generation: number; frame_seq: number } };
    client.sendJson({
      type: 'frame.ack',
      generation: first.meta.generation,
      frame_seq: first.meta.frame_seq,
    });
    await until(() => screencasts(client).length === 2);
  });

  it('refuses frames.start from a client that did not negotiate frames/1', async () => {
    const { server, captures } = await setup();
    const client = await peer(server, ['events']);
    client.sendJson({ type: 'frames.start' });
    await client.waitForFrames(2);
    expect(client.messages()[1]).toEqual({
      type: 'error',
      code: 'unsupported',
      message: 'frames.start',
    });
    expect(captures).toHaveLength(0);
  });

  it('writes frames.cleared before any later frame and never a frame of an older generation after it', async () => {
    const { server, hub, emit, page } = await setup();
    const client = await peer(server);
    client.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing);
    emit();
    await until(() => screencasts(client).length === 1);
    page.latch.latch(0);
    await until(() => typed(client, 'frames.cleared').length === 1);
    const clearedIndex = client.frames.findIndex(
      (frame) =>
        frame.kind === 'json' && (frame.message as { type?: string }).type === 'frames.cleared',
    );
    const cleared = (client.frames[clearedIndex] as { message: { generation: number } }).message;
    const later = client.frames
      .slice(clearedIndex + 1)
      .filter((frame) => frame.kind === 'screencast') as { meta: { generation: number } }[];
    expect(later.every((frame) => frame.meta.generation >= cleared.generation)).toBe(true);
  });

  it('keeps answering control traffic while frame acks stall', async () => {
    const { server, hub, emit } = await setup();
    const client = await peer(server);
    client.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing);
    for (let index = 0; index < 20; index += 1) emit(64 * 1024);
    await until(() => screencasts(client).length === 1);
    const before = typed(client, 'heartbeat').length;
    client.sendJson({ type: 'ping' });
    await until(() => typed(client, 'heartbeat').length === before + 1);
    server.broadcast({ type: 'cancel_ack', already_cancelling: false, honored: true });
    await until(() => typed(client, 'cancel_ack').length === 1);
    // Still one frame: the stalled client never acked.
    expect(screencasts(client)).toHaveLength(1);
  });

  it('never writes a frame over 4 MiB, and offers the next one', async () => {
    const { server, hub, emit } = await setup();
    const client = await peer(server);
    client.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing);
    emit(MAX_SCREENCAST_FRAME_BYTES);
    emit(64);
    await until(() => screencasts(client).length === 1);
    const only = screencasts(client)[0] as { jpeg: Buffer };
    expect(only.jpeg.length).toBe(64);
  });

  it('gives two clients their own slots', async () => {
    const { server, hub, emit } = await setup();
    const slow = await peer(server);
    const fast = await peer(server);
    slow.sendJson({ type: 'frames.start' });
    fast.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing && hub.clientCount === 2);
    for (let index = 0; index < 4; index += 1) {
      emit();
      await until(() => screencasts(fast).length === index + 1);
      const last = screencasts(fast).at(-1) as { meta: { generation: number; frame_seq: number } };
      fast.sendJson({
        type: 'frame.ack',
        generation: last.meta.generation,
        frame_seq: last.meta.frame_seq,
      });
    }
    expect(screencasts(fast)).toHaveLength(4);
    expect(screencasts(slow)).toHaveLength(1);
  });

  it('stops capture when the last client disconnects mid-frame', async () => {
    const { server, hub, emit, running } = await setup();
    const one = await peer(server);
    const two = await peer(server);
    one.sendJson({ type: 'frames.start' });
    two.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing);
    emit();
    one.destroy();
    await until(() => hub.clientCount === 1);
    expect(hub.capturing).toBe(true);
    two.destroy();
    await until(() => !hub.capturing && running().length === 0);
  });

  it('stops capture on frames.stop', async () => {
    const { server, hub } = await setup();
    const client = await peer(server);
    client.sendJson({ type: 'frames.start' });
    await until(() => hub.capturing);
    client.sendJson({ type: 'frames.stop' });
    await until(() => !hub.capturing);
  });
});

describe('@no-llm OutboundQueues.dropFrame', () => {
  it('drops the unsent frame but keeps queued events', () => {
    const written: Buffer[] = [];
    let accept = false;
    const listeners = new Map<string, () => void>();
    const queues = new OutboundQueues(
      {
        write: (chunk) => {
          written.push(chunk);
          return accept;
        },
        once: (event, listener) => {
          listeners.set(event, listener);
        },
        destroyed: false,
      },
      { onOverflow: () => undefined },
    );
    queues.enqueue(Buffer.from('event-1'));
    queues.offerFrame(Buffer.from('frame'));
    queues.enqueue(Buffer.from('event-2'));
    queues.dropFrame();
    accept = true;
    listeners.get('drain')?.();
    expect(written.map((chunk) => chunk.toString())).toEqual(['event-1', 'event-2']);
  });
});

describe('@no-llm RunChannelClient screencast frames', () => {
  it('hands the host each frame after negotiating frames/1 and sending frames.start', async () => {
    const { server, hub, emit } = await setup();
    const runDir = makeRunDir();
    const client = new RunChannelClient({
      clientKind: 'host',
      runDir,
      capabilities: ['events', FRAMES_CAPABILITY],
    });
    try {
      const attached = await client.connect(leaseFor('r1', server.address));
      expect(attached).toMatchObject({
        state: 'attached',
        capabilities: expect.arrayContaining([FRAMES_CAPABILITY]) as unknown,
      });
      const frames: { meta: unknown; jpeg: Buffer }[] = [];
      client.onScreencastFrame((meta, jpeg) => frames.push({ meta, jpeg }));
      client.send({ type: 'frames.start', max_width: 1280, max_height: 800 });
      await until(() => hub.capturing);
      emit(48);
      await until(() => frames.length === 1);
      expect(frames[0]!.meta).toMatchObject({
        generation: expect.any(Number) as unknown,
        frame_seq: 0,
      });
      expect(frames[0]!.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    } finally {
      client.close();
    }
  });
});
