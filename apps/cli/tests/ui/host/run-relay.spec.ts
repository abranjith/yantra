// @no-llm
/**
 * The run relay (FEAT-065 TASK-016): per-window `from_seq`, gap-free and
 * duplicate-free delivery across replay and live, incompatible owners,
 * finished runs and a silent worker.
 */

import type {
  ChannelConnectResult,
  ChannelEventDelivery,
  CommittedEvent,
  LeaseRead,
  RunChannelClientSnapshot,
} from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import type { RpcConnection } from '../../../src/ui/host/rpc-server.js';
import { RunRelay, type RelayClient } from '../../../src/ui/host/run-relay.js';

const RUN = '20261111T100000Z-research-0000abcd';

function event(seq: number): CommittedEvent {
  return { seq, event: { kind: 'test_event', n: seq } as never };
}

/** A run's log: events are appended (persisted) before they are published live. */
class FakeLog {
  public readonly events: CommittedEvent[] = [];
  public readDelayMs = 0;
  public append(seq: number): void {
    this.events.push(event(seq));
  }
  public readonly read = async function* (this: FakeLog, _runDir: string, fromSeq: number) {
    for (const item of [...this.events]) {
      if (this.readDelayMs > 0)
        await new Promise((resolve) => setTimeout(resolve, this.readDelayMs));
      if (item.seq >= fromSeq) yield item;
    }
  };
}

class FakeClient implements RelayClient {
  public result: ChannelConnectResult = {
    state: 'attached',
    capabilities: ['events', 'cancel'],
    channelVersion: 1,
  };
  public subscribedFrom: number | null = null;
  public closed = false;
  public cancelCalls = 0;
  private snapshot: RunChannelClientSnapshot = {
    state: 'attached',
    lastSeq: 0,
    ownerVersion: null,
  };
  private readonly listeners = new Set<(delivery: ChannelEventDelivery) => void>();
  private readonly snapshotListeners = new Set<() => void>();
  public connect(): Promise<ChannelConnectResult> {
    return Promise.resolve(this.result);
  }
  public subscribe(fromSeq: number): void {
    this.subscribedFrom = fromSeq;
  }
  public onEvent(listener: (delivery: ChannelEventDelivery) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public getSnapshot(): RunChannelClientSnapshot {
    return this.snapshot;
  }
  public subscribeSnapshot(listener: () => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
  public readonly sent: unknown[] = [];
  public send(message: unknown): void {
    this.sent.push(message);
  }
  public close(): void {
    this.closed = true;
  }
  /** The owner publishes `seq` live. */
  public emit(seq: number): void {
    for (const listener of this.listeners)
      listener({ seq, event: event(seq).event, fromFile: false });
  }
  public setState(state: RunChannelClientSnapshot['state']): void {
    this.snapshot = { ...this.snapshot, state };
    for (const listener of this.snapshotListeners) listener();
  }
}

function connection(id: number) {
  const sent: [string, Record<string, unknown>][] = [];
  const closers: (() => void)[] = [];
  const value: RpcConnection = {
    id,
    windowId: `w${id}`,
    notify: (method, params) => sent.push([method, params]),
    onClose: (listener) => closers.push(listener),
  };
  return {
    value,
    sent,
    close: () => {
      for (const closer of closers) closer();
    },
    seqs: () =>
      sent.filter(([method]) => method === 'run.event').map(([, params]) => params.seq as number),
  };
}

const LEASE: LeaseRead = { kind: 'lease', lease: {} as never };

function makeRelay(log: FakeLog, client: FakeClient, lease: LeaseRead = LEASE): RunRelay {
  return new RunRelay({
    runsRoot: '/runs',
    createClient: () => client,
    readEvents: log.read.bind(log) as never,
    readLease: () => Promise.resolve(lease),
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('delivery', () => {
  it('gives two windows with different from_seq each a gap-free sequence without duplicates', async () => {
    // Arrange: five events are already in the log.
    const log = new FakeLog();
    for (let seq = 1; seq <= 5; seq++) log.append(seq);
    const client = new FakeClient();
    const relay = makeRelay(log, client);
    const a = connection(1);
    const b = connection(2);

    // Act: A wants everything, B starts at 3; the owner then publishes 4..8
    // (4 and 5 again, as a replay overlap would), each persisted first.
    await relay.follow(a.value, RUN, 1);
    await relay.follow(b.value, RUN, 3);
    for (let seq = 4; seq <= 8; seq++) {
      if (seq > 5) log.append(seq);
      client.emit(seq);
    }
    await settle();

    // Assert
    expect(a.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.seqs()).toEqual([3, 4, 5, 6, 7, 8]);
    expect(client.subscribedFrom).toBe(1);
  });

  it('delivers an event published during the replay exactly once', async () => {
    const log = new FakeLog();
    for (let seq = 1; seq <= 3; seq++) log.append(seq);
    log.readDelayMs = 10;
    const client = new FakeClient();
    const relay = makeRelay(log, client);
    const a = connection(1);

    await relay.follow(a.value, RUN, 1);
    log.append(4);
    client.emit(4); // arrives while the replay is still reading
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(a.seqs()).toEqual([1, 2, 3, 4]);
  });

  it('fills a gap in live events from the file', async () => {
    const log = new FakeLog();
    log.append(1);
    const client = new FakeClient();
    const relay = makeRelay(log, client);
    const a = connection(1);
    await relay.follow(a.value, RUN, 1);
    await settle();
    log.append(2);
    log.append(3);
    client.emit(3); // the live stream skipped 2
    await settle();
    expect(a.seqs()).toEqual([1, 2, 3]);
  });
});

describe('owners', () => {
  it('marks an incompatible worker live_unavailable and never sends it anything', async () => {
    const log = new FakeLog();
    log.append(1);
    const client = new FakeClient();
    client.result = { state: 'live_unavailable', ownerVersion: '0.9.0' };
    const relay = makeRelay(log, client);
    const a = connection(1);

    const channel = await relay.follow(a.value, RUN, 1);
    await settle();

    expect(channel).toBe('live_unavailable');
    expect(client.closed).toBe(true);
    expect(client.cancelCalls).toBe(0);
    expect(client.subscribedFrom).toBeNull();
    expect(a.sent).toContainEqual([
      'run.channel',
      { run_id: RUN, state: 'live_unavailable', worker_version: '0.9.0' },
    ]);
    expect(a.seqs()).toEqual([1]);
  });

  it('serves a finished run (no lease) from the file only', async () => {
    const log = new FakeLog();
    for (let seq = 1; seq <= 3; seq++) log.append(seq);
    const create = vi.fn();
    const relay = new RunRelay({
      runsRoot: '/runs',
      createClient: create,
      readEvents: log.read.bind(log) as never,
      readLease: () => Promise.resolve({ kind: 'absent' }),
    });
    const a = connection(1);
    expect(await relay.follow(a.value, RUN, 2)).toBe('replay_only');
    await settle();
    expect(a.seqs()).toEqual([2, 3]);
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a silent worker once, and its recovery', async () => {
    const client = new FakeClient();
    const relay = makeRelay(new FakeLog(), client);
    const a = connection(1);
    await relay.follow(a.value, RUN, 1);

    client.setState('not_responding');
    client.setState('not_responding');
    client.setState('attached');

    const channel = a.sent
      .filter(([method]) => method === 'run.channel')
      .map(([, params]) => params.state);
    expect(channel).toEqual(['not_responding', 'recovered']);
  });
});

describe('attachment', () => {
  it('detaches the run when its last window unsubscribes or closes', async () => {
    const client = new FakeClient();
    const relay = makeRelay(new FakeLog(), client);
    const a = connection(1);
    const b = connection(2);
    await relay.follow(a.value, RUN, 1);
    await relay.follow(b.value, RUN, 1);
    relay.unfollow(1, RUN);
    expect(client.closed).toBe(false);
    b.close();
    expect(client.closed).toBe(true);
    expect(relay.attachedRuns()).toEqual([]);
  });

  it('attaches one client per run however many windows follow it', async () => {
    const create = vi.fn(() => new FakeClient());
    const relay = new RunRelay({
      runsRoot: '/runs',
      createClient: create,
      readEvents: new FakeLog().read as never,
      readLease: () => Promise.resolve(LEASE),
    });
    await relay.follow(connection(1).value, RUN, 1);
    await relay.follow(connection(2).value, RUN, 4);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
