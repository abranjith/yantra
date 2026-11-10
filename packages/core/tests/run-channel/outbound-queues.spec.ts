// @no-llm
/**
 * Bounded, prioritized outbound queues, backpressure and heartbeat (FEAT-064
 * TASK-007).
 */

import { EventEmitter } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';

import type { RunChannelEventPayload, RunSocketAddress } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunChannelClient } from '../../src/run-channel/client.js';
import type { CommittedEvent, RunEventSource } from '../../src/run-channel/event-source.js';
import { FrameDecoder, encodeJsonFrame } from '../../src/run-channel/frame-codec.js';
import { OutboundQueues, type OutboundSink } from '../../src/run-channel/outbound-queues.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import { allocateSocketAddress } from '../../src/run-channel/socket-address.js';

import {
  ManualTimers,
  RawPeer,
  TOKEN,
  capturingLogger,
  cleanupSandbox,
  leaseFor,
  makeRunDir,
  sandboxHome,
  silentLogger,
  until,
} from './support.js';

/** A sink that accepts `capacity` writes before reporting full, until drained. */
class FakeSink extends EventEmitter implements OutboundSink {
  public readonly written: Buffer[] = [];
  public destroyed = false;
  private room: number;

  public constructor(private readonly capacity = Number.POSITIVE_INFINITY) {
    super();
    this.room = capacity;
  }

  public write(chunk: Buffer): boolean {
    this.written.push(chunk);
    this.room -= 1;
    return this.room > 0;
  }

  public drain(): void {
    this.room = this.capacity;
    this.emit('drain');
  }

  public close(): void {
    this.destroyed = true;
    this.emit('close');
  }
}

function json(message: unknown): Buffer {
  return encodeJsonFrame(message);
}

const MIB = 1024 * 1024;

describe('@no-llm OutboundQueues', () => {
  it('writes a control message before any screencast frame, and keeps only the newest frame', () => {
    const sink = new FakeSink(1); // full after the first write
    const queues = new OutboundQueues(sink, { onOverflow: () => undefined });
    queues.enqueue(json({ type: 'heartbeat', at: 'x' })); // fills the sink
    for (let index = 0; index < 20; index += 1) {
      const frame = Buffer.alloc(3 * MIB);
      frame.writeUInt8(0x02, 0);
      frame.writeUInt32BE(index, 1);
      queues.offerFrame(frame);
    }
    queues.enqueue(json({ type: 'cancel_ack', already_cancelling: false, honored: true }));
    sink.drain();
    sink.drain();
    const kinds = sink.written.map((chunk) => chunk.readUInt8(0));
    expect(kinds).toEqual([0x01, 0x01, 0x02]);
    expect(sink.written[2]?.readUInt32BE(1)).toBe(19);
    expect(queues.droppedFrames).toBe(19);
  });

  it('waits for drain when write() returns false, then continues in order', () => {
    const sink = new FakeSink(2);
    const queues = new OutboundQueues(sink, { onOverflow: () => undefined });
    for (let index = 0; index < 5; index += 1) queues.enqueue(json({ n: index }));
    expect(sink.written).toHaveLength(2);
    expect(queues.eventBytes).toBeGreaterThan(0);
    sink.drain();
    expect(sink.written).toHaveLength(4);
    sink.drain();
    expect(sink.written).toHaveLength(5);
    expect(queues.eventBytes).toBe(0);
    expect(
      sink.written.map((chunk) => JSON.parse(chunk.subarray(5).toString()) as unknown),
    ).toEqual([0, 1, 2, 3, 4].map((n) => ({ n })));
  });

  it('overflows once at the byte bound, synchronously, and accepts nothing after', () => {
    const sink = new FakeSink(1);
    let overflows = 0;
    const queues = new OutboundQueues(sink, {
      maxEventBytes: 1_000,
      onOverflow: () => {
        overflows += 1;
      },
    });
    queues.enqueue(json({ fill: 'x' })); // written; the sink is now full
    let accepted = 0;
    for (let index = 0; index < 100; index += 1) {
      if (queues.enqueue(json({ pad: 'y'.repeat(80) }))) accepted += 1;
    }
    expect(overflows).toBe(1);
    expect(accepted).toBeLessThan(15);
    expect(queues.closed).toBe(true);
  });

  it('paces replay frames by writes without counting them against the bound', async () => {
    const sink = new FakeSink(1);
    const queues = new OutboundQueues(sink, {
      maxEventBytes: 100,
      onOverflow: () => {
        throw new Error('replay must not overflow');
      },
    });
    let resolved = 0;
    const replays = Array.from({ length: 5 }, () =>
      queues.enqueueReplay(Buffer.alloc(500)).then(() => {
        resolved += 1;
      }),
    );
    await Promise.resolve();
    expect(resolved).toBe(1);
    for (let index = 0; index < 4; index += 1) sink.drain();
    await Promise.all(replays);
    expect(resolved).toBe(5);
    expect(queues.eventBytes).toBe(0);
  });

  it('releases waiting replays when the socket closes', async () => {
    const sink = new FakeSink(1);
    const queues = new OutboundQueues(sink, { onOverflow: () => undefined });
    const replays = [queues.enqueueReplay(Buffer.alloc(8)), queues.enqueueReplay(Buffer.alloc(8))];
    sink.close();
    await Promise.all(replays);
    expect(queues.closed).toBe(true);
  });

  it('runs drainThen once everything queued is written, dropping an unsent frame', () => {
    const sink = new FakeSink(1);
    const queues = new OutboundQueues(sink, { onOverflow: () => undefined });
    queues.enqueue(json({ a: 1 }));
    queues.enqueue(json({ b: 2 }));
    queues.offerFrame(Buffer.from([0x02, 0, 0, 0, 0]));
    let ended = false;
    queues.drainThen(() => {
      ended = true;
    });
    expect(ended).toBe(false);
    sink.drain();
    expect(ended).toBe(true);
    expect(sink.written.map((chunk) => chunk.readUInt8(0))).toEqual([0x01, 0x01]);
  });
});

/** A committed log that grows on demand. */
class GrowingSource implements RunEventSource {
  private readonly events: CommittedEvent[] = [];
  private readonly listeners = new Set<(event: CommittedEvent) => void>();

  public get lastSeq(): number {
    return this.events.length;
  }

  public emit(event: RunChannelEventPayload): void {
    const committed = { seq: this.events.length + 1, event };
    this.events.push(committed);
    for (const listener of this.listeners) listener(committed);
  }

  public subscribe(listener: (event: CommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async *read(fromSeq: number): AsyncGenerator<CommittedEvent> {
    await Promise.resolve();
    yield* this.events.slice(Math.max(0, fromSeq - 1));
  }
}

const closers: (() => Promise<void> | void)[] = [];

/**
 * An authenticated, subscribed client that never reads. A paused Node socket
 * keeps reading a pipe on Windows, so there the pipe is opened as a plain file
 * handle that is never read; on POSIX a paused socket stops reading.
 */
async function stalledClient(address: RunSocketAddress): Promise<{ release(): void }> {
  const hello = encodeJsonFrame({
    type: 'hello',
    token: TOKEN,
    channel_version: 1,
    capabilities: ['events'],
    client_kind: 'test',
  });
  const subscribe = encodeJsonFrame({ type: 'subscribe', from_seq: 1 });
  if (process.platform === 'win32') {
    const fd = openSync(address.address, 'r+');
    writeSync(fd, hello);
    writeSync(fd, subscribe);
    return {
      release: () => {
        try {
          closeSync(fd);
        } catch {
          // already closed by the server dropping the pipe
        }
      },
    };
  }
  const peer = await RawPeer.open(address);
  peer.write(hello);
  await peer.waitForFrames(1);
  peer.write(subscribe);
  peer.socket.pause();
  return {
    release: () => {
      peer.destroy();
    },
  };
}

describe('@no-llm run socket under a slow client', () => {
  beforeEach(() => {
    sandboxHome();
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanupSandbox();
  });

  it('drops a client that stops reading at the bound while a fast client keeps every event', async () => {
    const source = new GrowingSource();
    const { logger, lines } = capturingLogger();
    const server = await RunChannelServer.listen({
      runId: 'r1',
      token: TOKEN,
      logger,
      events: source,
    });
    closers.push(() => server.close(0));

    const slow = await stalledClient(server.address);
    closers.push(() => {
      slow.release();
    });
    const overflowed = (): boolean => lines.some((line) => line.includes('channel_overflow'));
    await until(() => server.connectionCount === 1);

    const fast = new RunChannelClient({
      clientKind: 'test',
      runDir: makeRunDir(),
      logger: silentLogger,
    });
    closers.push(() => {
      fast.close();
    });
    const received: number[] = [];
    const latency: number[] = [];
    const sentAt = new Map<number, number>();
    fast.onEvent((delivery) => {
      received.push(delivery.seq);
      latency.push(performance.now() - (sentAt.get(delivery.seq) ?? 0));
    });
    await fast.connect(leaseFor('r1', server.address));
    fast.subscribe(1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // 4 KiB events, 10 per millisecond: the stalled client passes the 8 MiB
    // bound after about 2,000 events while the reading one keeps up.
    const text = 'z'.repeat(4 * 1024);
    let next = 0;
    while (!overflowed() && next < 6_000) {
      for (let burst = 0; burst < 10; burst += 1) {
        next += 1;
        sentAt.set(next, performance.now());
        source.emit({ kind: 'assistant_text', text, at: '2026-11-09T12:00:00.000Z' });
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(overflowed()).toBe(true);
    await until(() => received.length === next, 15_000).catch((error: unknown) => {
      throw new Error(
        `fast=${received.length} sent=${next} overflowed=${overflowed()} fast=${fast.getSnapshot().state} ${String(error)}`,
      );
    });
    expect(received).toEqual(Array.from({ length: next }, (_, index) => index + 1));
    expect(fast.gaps).toBe(0);
    await until(() => server.connectionCount === 1);
    const sorted = [...latency].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    // Enqueue-to-delivery for the reading client, end to end; generous for CI.
    expect(p95).toBeLessThan(250);
  }, 30_000);
});

describe('@no-llm heartbeat and not_responding', () => {
  beforeEach(() => {
    sandboxHome();
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    cleanupSandbox();
  });

  it('sends one heartbeat per 5 s per connection on the injected clock', async () => {
    const timers = new ManualTimers();
    const server = await RunChannelServer.listen({
      runId: 'r1',
      token: TOKEN,
      logger: silentLogger,
      timers,
    });
    closers.push(() => server.close(0));
    const peer = await RawPeer.open(server.address);
    peer.hello();
    await peer.waitForFrames(1);
    timers.advance(4_999);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.frames).toHaveLength(1);
    timers.advance(1);
    await peer.waitForFrames(2);
    timers.advance(10_000);
    await peer.waitForFrames(4);
    expect(
      peer
        .messages()
        .slice(1)
        .map((message) => (message as { type: string }).type),
    ).toEqual(['heartbeat', 'heartbeat', 'heartbeat']);
  });

  it('flips to not_responding at exactly 30 s of silence and back on the next frame', async () => {
    const address = await allocateSocketAddress();
    let owner: Socket | null = null;
    const server: Server = createServer((socket) => {
      owner = socket;
      const decoder = new FrameDecoder();
      socket.on('error', () => undefined);
      socket.on('data', (chunk: Buffer) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === 'json' && (frame.message as { type: string }).type === 'hello') {
            socket.write(
              encodeJsonFrame({
                type: 'hello_ok',
                channel_version: 1,
                supported: { min: 1, max: 1 },
                capabilities: [],
                run_id: 'r1',
              }),
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(address.address, resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          (owner as Socket | null)?.destroy();
          server.close(() => resolve());
        }),
    );
    const timers = new ManualTimers();
    const { logger, lines } = capturingLogger();
    const client = new RunChannelClient({
      clientKind: 'test',
      runDir: makeRunDir(),
      logger,
      timers,
    });
    closers.push(() => {
      client.close();
    });
    const connected = client.connect(leaseFor('r1', address));
    await until(() => owner !== null);
    expect((await connected).state).toBe('attached');
    timers.advance(29_999);
    expect(client.getSnapshot().state).toBe('attached');
    timers.advance(1);
    expect(client.getSnapshot().state).toBe('not_responding');
    timers.advance(60_000);
    expect(lines.filter((line) => line.includes('run_channel_not_responding'))).toHaveLength(1);
    (owner as unknown as Socket).write(
      encodeJsonFrame({ type: 'heartbeat', at: '2026-11-09T12:00:00.000Z' }),
    );
    await until(() => client.getSnapshot().state === 'attached');
  });
});
