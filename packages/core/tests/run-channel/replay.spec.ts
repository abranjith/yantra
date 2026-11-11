// @no-llm
/**
 * Atomic replay-to-live subscription and gap-free reconnect (FEAT-064
 * TASK-006, with the RC3 file fallback), over real sockets.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunChannelEventPayload, RunEventType } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunChannelClient, type ChannelEventDelivery } from '../../src/run-channel/client.js';
import {
  streamEventSource,
  type CommittedEvent,
  type RunEventSource,
} from '../../src/run-channel/event-source.js';
import { RunChannelServer } from '../../src/run-channel/server.js';
import { RUN_EVENTS_FILENAME } from '../../src/run-events/log.js';
import { RunEventStream } from '../../src/run-events/stream.js';
import { publishLease } from '../../src/run-ownership/lease-store.js';
import { runOutcome } from '../run-events/support.js';

import {
  RawPeer,
  TOKEN,
  cleanupSandbox,
  leaseFor,
  makeRunDir,
  sandboxHome,
  silentLogger,
  until,
} from './support.js';

const closers: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  sandboxHome();
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  cleanupSandbox();
});

const AT = '2026-11-09T12:00:00.000Z';

function text(n: number): RunEventType {
  return { kind: 'assistant_text', text: `t${n}`, at: AT };
}

/** An in-memory committed log: emit() commits then notifies, like the real stream. */
class MemorySource implements RunEventSource {
  public readonly events: CommittedEvent[] = [];
  private readonly listeners = new Set<(event: CommittedEvent) => void>();
  public readsYieldEvery = 50;

  public get lastSeq(): number {
    return this.events.length;
  }

  public emit(event: RunChannelEventPayload = text(this.events.length + 1)): void {
    const committed = { seq: this.events.length + 1, event };
    this.events.push(committed);
    for (const listener of this.listeners) listener(committed);
  }

  public emitMany(count: number): void {
    for (let index = 0; index < count; index += 1) this.emit();
  }

  public subscribe(listener: (event: CommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async *read(fromSeq: number): AsyncGenerator<CommittedEvent> {
    // Reads the file as it is when each line is reached, like the real reader,
    // and yields to the event loop so live emits interleave with the replay.
    for (let index = Math.max(0, fromSeq - 1); index < this.events.length; index += 1) {
      if (index % this.readsYieldEvery === 0) await new Promise((r) => setImmediate(r));
      const event = this.events[index];
      if (event !== undefined) yield event;
    }
  }
}

async function serve(events?: RunEventSource): Promise<RunChannelServer> {
  const server = await RunChannelServer.listen({
    runId: 'r1',
    token: TOKEN,
    logger: silentLogger,
    ...(events === undefined ? {} : { events }),
  });
  closers.push(() => server.close(0));
  return server;
}

function attach(runDir = makeRunDir()): { client: RunChannelClient; seen: ChannelEventDelivery[] } {
  const client = new RunChannelClient({
    clientKind: 'test',
    runDir,
    logger: silentLogger,
    sleep: () => Promise.resolve(),
  });
  const seen: ChannelEventDelivery[] = [];
  client.onEvent((delivery) => seen.push(delivery));
  closers.push(() => {
    client.close();
  });
  return { client, seen };
}

function seqs(seen: readonly ChannelEventDelivery[]): number[] {
  return seen.map((delivery) => delivery.seq);
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

describe('@no-llm subscribe: gap-free attach', () => {
  it('replays 1..1,000 to a client subscribing at 0, then continues live', async () => {
    const source = new MemorySource();
    source.emitMany(1_000);
    const server = await serve(source);
    const { client, seen } = attach();
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    await until(() => seen.length === 1_000);
    source.emitMany(10);
    await until(() => seen.length === 1_010);
    expect(seqs(seen)).toEqual(range(1, 1_010));
    expect(client.gaps).toBe(0);
  });

  it('delivers exactly 1..10,500 when 500 events are emitted during a 10,000-event replay', async () => {
    const source = new MemorySource();
    source.emitMany(10_000);
    const server = await serve(source);
    const { client, seen } = attach();
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    let emitted = 0;
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        source.emitMany(10);
        emitted += 10;
        if (emitted < 500) setImmediate(tick);
        else resolve();
      };
      setImmediate(tick);
    });
    await until(() => seen.length >= 10_500, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seqs(seen)).toEqual(range(1, 10_500));
    expect(client.gaps).toBe(0);
  }, 30_000);

  it('gives a second client attaching mid-run the same sequence', async () => {
    const source = new MemorySource();
    const server = await serve(source);
    const first = attach();
    await first.client.connect(leaseFor('r1', server.address));
    first.client.subscribe(0);
    source.emitMany(300);
    await until(() => first.seen.length === 300);
    const second = attach();
    await second.client.connect(leaseFor('r1', server.address));
    second.client.subscribe(1);
    source.emitMany(200);
    await until(() => first.seen.length === 500 && second.seen.length === 500);
    expect(seqs(second.seen)).toEqual(seqs(first.seen));
    expect(second.client.gaps).toBe(0);
  });

  it('reconnects after a drop at 400 from 401, with no gaps or duplicates', async () => {
    const runDir = makeRunDir();
    const source = new MemorySource();
    source.emitMany(400);
    const server = await serve(source);
    await publishLease(runDir, leaseFor('r1', server.address));
    const { client, seen } = attach(runDir);
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    await until(() => seen.length === 400);
    // Drop the connection from the client side, as a network blip would.
    (client as unknown as { socket: { destroy(): void } }).socket.destroy();
    await until(() => client.getSnapshot().state === 'disconnected');
    source.emitMany(100);
    const result = await client.reconnect();
    expect(result.state).toBe('attached');
    await until(() => seen.length === 500);
    expect(seqs(seen)).toEqual(range(1, 500));
    expect(client.gaps).toBe(0);
  });

  it('restarts from its own from_seq on a second subscribe', async () => {
    const source = new MemorySource();
    source.emitMany(20);
    const server = await serve(source);
    const peer = await RawPeer.open(server.address);
    peer.hello();
    await peer.waitForFrames(1);
    peer.sendJson({ type: 'subscribe', from_seq: 15 });
    await peer.waitForFrames(7);
    peer.sendJson({ type: 'subscribe', from_seq: 18 });
    await peer.waitForFrames(10);
    const received = peer
      .messages()
      .slice(1)
      .map((message) => (message as { seq: number }).seq);
    expect(received).toEqual([15, 16, 17, 18, 19, 20, 18, 19, 20]);
  });
});

describe('@no-llm subscribe: limits and edges', () => {
  it('sends event_oversize, with its seq, for an event too large for a frame', async () => {
    const source = new MemorySource();
    source.emit();
    source.emit({ kind: 'assistant_text', text: 'x'.repeat(1_100_000), at: AT });
    source.emit();
    const server = await serve(source);
    const { client, seen } = attach();
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(1);
    await until(() => seen.length === 3);
    expect(seen.map((delivery) => [delivery.seq, delivery.event === null])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
  });

  it('goes straight to live when from_seq is beyond the watermark', async () => {
    const source = new MemorySource();
    source.emitMany(5);
    const server = await serve(source);
    const { client, seen } = attach();
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(9);
    source.emitMany(10);
    await until(() => seen.length === 7);
    expect(seqs(seen)).toEqual(range(9, 15));
  });

  it('holds a subscribe that arrives before the event log is attached', async () => {
    const server = await serve();
    const { client, seen } = attach();
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const source = new MemorySource();
    source.emitMany(3);
    server.attachEvents(source);
    source.emitMany(2);
    await until(() => seen.length === 5);
    expect(seqs(seen)).toEqual(range(1, 5));
  });

  it('replays from the real writer and never delivers a trailing partial line', async () => {
    const runDir = makeRunDir();
    const stream = new RunEventStream({ logger: silentLogger });
    stream.open({ runDir, runId: 'r1', sync: () => undefined });
    closers.push(() => {
      stream.close();
    });
    for (let index = 1; index <= 3; index += 1) stream.emit(text(index));
    appendFileSync(join(runDir, RUN_EVENTS_FILENAME), '{"schema_version":"1","seq":4,"ev');
    const server = await serve(streamEventSource(stream, runDir));
    const { client, seen } = attach(runDir);
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    await until(() => seen.length === 3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seqs(seen)).toEqual([1, 2, 3]);
    expect(seen.every((delivery) => !delivery.fromFile)).toBe(true);
  });

  it('reads the file from lastSeq + 1 when the owner closes before the terminal event (RC3)', async () => {
    const runDir = makeRunDir();
    const stream = new RunEventStream({ logger: silentLogger });
    stream.open({ runDir, runId: 'r1', sync: () => undefined });
    closers.push(() => {
      stream.close();
    });
    stream.emit(text(1));
    const live = streamEventSource(stream, runDir);
    let forwarding = true;
    const lossy: RunEventSource = {
      get lastSeq() {
        return live.lastSeq;
      },
      subscribe: (listener) => live.subscribe((event) => forwarding && listener(event)),
      read: (fromSeq) => live.read(fromSeq),
    };
    const server = await serve(lossy);
    const { client, seen } = attach(runDir);
    await client.connect(leaseFor('r1', server.address));
    client.subscribe(0);
    await until(() => seen.length === 1);
    forwarding = false; // the owner commits these, then exits without sending them
    stream.emit(text(2));
    stream.emit(runOutcome());
    await server.close(0);
    await until(() => client.getSnapshot().state === 'ended');
    expect(seqs(seen)).toEqual([1, 2, 3]);
    expect(seen.slice(1).every((delivery) => delivery.fromFile)).toBe(true);
  });
});
