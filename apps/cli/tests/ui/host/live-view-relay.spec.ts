// @no-llm
/**
 * The live-view relay (FEAT-069 TASK-009): generation floors per hop,
 * per-window latest-wins slots, the binary lane under backpressure, and the
 * subscribe lifecycle, with a fake worker channel and fake windows.
 */

import { FRAMES_CAPABILITY, decodeFramePayload, type ScreencastFrameMeta } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  LiveViewRelay,
  WINDOW_BUFFER_LIMIT,
  type LiveViewRunSource,
} from '../../../src/ui/host/live-view-relay.js';
import { RpcMethodRegistry, type RpcConnection } from '../../../src/ui/host/rpc-server.js';
import type { RelayChannel, RelayClient } from '../../../src/ui/host/run-relay.js';

const RUN = '20261115T100000Z-do-0000abcd';

class FakeWorker {
  public readonly sent: ({ readonly type: string } & Record<string, unknown>)[] = [];
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly frameListeners = new Set<(meta: unknown, jpeg: Uint8Array) => void>();
  public readonly client = {
    send: (message: { readonly type: string } & Record<string, unknown>) => this.sent.push(message),
    onServerMessage: (listener: (message: unknown) => void) => {
      this.messageListeners.add(listener);
      return () => this.messageListeners.delete(listener);
    },
    onScreencastFrame: (listener: (meta: unknown, jpeg: Uint8Array) => void) => {
      this.frameListeners.add(listener);
      return () => this.frameListeners.delete(listener);
    },
  } as unknown as RelayClient;

  public message(message: Record<string, unknown>): void {
    for (const listener of this.messageListeners) listener(message);
  }

  public frame(generation: number, frameSeq: number, size = 16): void {
    const meta: ScreencastFrameMeta = {
      generation,
      frame_seq: frameSeq,
      document_epoch: 1,
      captured_at: '2026-11-15T10:00:00.000Z',
      width: 10,
      height: 10,
    };
    const jpeg = new Uint8Array(size);
    jpeg[0] = 0xff;
    jpeg[1] = 0xd8;
    for (const listener of this.frameListeners) listener(meta, jpeg);
  }

  public types(): string[] {
    return this.sent.map((message) => message.type);
  }

  public get listening(): number {
    return this.messageListeners.size + this.frameListeners.size;
  }
}

function runs(
  worker: FakeWorker | null,
  options: { channel?: RelayChannel; capabilities?: string[] } = {},
): LiveViewRunSource {
  return {
    owner: (runId) =>
      runId !== RUN
        ? null
        : {
            channel: options.channel ?? (worker === null ? 'replay_only' : 'live'),
            live:
              worker === null
                ? null
                : {
                    client: worker.client,
                    capabilities: options.capabilities ?? ['events', FRAMES_CAPABILITY],
                  },
          },
  };
}

function window(id: number) {
  const notes: [string, Record<string, unknown>][] = [];
  const binary: Uint8Array[] = [];
  const order: string[] = [];
  const closers: (() => void)[] = [];
  let buffered = 0;
  const connection: RpcConnection = {
    id,
    windowId: `w${id}`,
    notify: (method, params) => {
      notes.push([method, params]);
      order.push(method);
    },
    onClose: (listener) => closers.push(listener),
    sendBinary: (bytes) => {
      binary.push(bytes);
      order.push('frame');
      return true;
    },
    bufferedAmount: () => buffered,
  };
  return {
    connection,
    notes,
    binary,
    order,
    setBuffered: (value: number) => {
      buffered = value;
    },
    close: () => {
      for (const closer of closers) closer();
    },
    generations: () =>
      binary.map((bytes) => {
        const decoded = decodeFramePayload(bytes);
        if (decoded instanceof Error) throw decoded;
        return decoded.meta.generation;
      }),
    seqs: () =>
      binary.map((bytes) => {
        const decoded = decodeFramePayload(bytes);
        if (decoded instanceof Error) throw decoded;
        return decoded.meta.frame_seq;
      }),
  };
}

function relay(
  source: LiveViewRunSource,
  overrides: Partial<ConstructorParameters<typeof LiveViewRelay>[0]> = {},
) {
  const info = vi.fn();
  const instance = new LiveViewRelay({
    runs: source,
    logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    ...overrides,
  });
  return { relay: instance, info };
}

describe('@no-llm live-view relay: generation floor', () => {
  it('drops, for every window, a delayed older frame that arrives after frames.cleared', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    const b = window(2);
    host.subscribe(a.connection, RUN);
    host.subscribe(b.connection, RUN);
    worker.message({ type: 'frames.cleared', generation: 5, reason: 'protection' });
    worker.frame(4, 10);
    expect(a.binary).toHaveLength(0);
    expect(b.binary).toHaveLength(0);
    expect(host.droppedBelowFloor).toBe(1);
    // Still acked to the worker on receipt, so its pace never waits on a window.
    expect(worker.sent.filter((message) => message.type === 'frame.ack')).toHaveLength(1);
  });

  it('sends frames.cleared to every window at once and purges their queued older frames', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    const b = window(2);
    host.subscribe(a.connection, RUN);
    host.subscribe(b.connection, RUN);
    worker.frame(1, 0);
    worker.frame(1, 1);
    expect(a.seqs()).toEqual([0]);
    worker.message({ type: 'frames.cleared', generation: 2, reason: 'protection' });
    host.subscribe(a.connection, RUN);
    // a acks frame 0: its queued frame 1 (generation 1) was purged, nothing follows.
    host.windowAck(1, RUN, 0);
    expect(a.seqs()).toEqual([0]);
    for (const w of [a, b]) {
      expect(w.notes.filter(([method]) => method === 'frames.cleared')).toEqual([
        ['frames.cleared', { run_id: RUN, generation: 2, reason: 'protection' }],
      ]);
    }
  });

  it('raises the floor from frames.state too and forwards it', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    host.subscribe(a.connection, RUN);
    worker.message({
      type: 'frames.state',
      generation: 7,
      state: 'live',
      reason: 'none',
      page: null,
    });
    worker.frame(6, 0);
    worker.frame(7, 1);
    expect(a.generations()).toEqual([7]);
    expect(a.notes.find(([method]) => method === 'frames.state')?.[1]).toMatchObject({
      run_id: RUN,
      generation: 7,
      state: 'live',
    });
    expect(host.subscribe(window(9).connection, RUN)).toMatchObject({
      generation: 7,
      state: 'live',
    });
  });

  it('ignores malformed worker messages and frames', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    host.subscribe(a.connection, RUN);
    worker.message({ type: 'frames.cleared', generation: -1, reason: 'protection' });
    worker.message({
      type: 'frames.state',
      generation: 1,
      state: 'weird',
      reason: 'none',
      page: null,
    });
    expect(a.notes).toEqual([]);
  });
});

describe('@no-llm live-view relay: delivery', () => {
  it('sends one frame per window until it acks, newest wins', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const methods = new RpcMethodRegistry();
    host.register(methods);
    const a = window(1);
    host.subscribe(a.connection, RUN);
    worker.frame(1, 0);
    worker.frame(1, 1);
    worker.frame(1, 2);
    expect(a.seqs()).toEqual([0]);
    host.windowAck(1, RUN, 0);
    expect(a.seqs()).toEqual([0, 2]);
  });

  it('does not let a stalled window slow a second window', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const stalled = window(1);
    const fast = window(2);
    host.subscribe(stalled.connection, RUN);
    host.subscribe(fast.connection, RUN);
    for (let seq = 0; seq < 5; seq += 1) {
      worker.frame(1, seq);
      host.windowAck(2, RUN, seq);
    }
    expect(fast.seqs()).toEqual([0, 1, 2, 3, 4]);
    expect(stalled.seqs()).toEqual([0]);
  });

  it('holds a frame while the socket is backed up, so JSON-RPC goes first, then sends it', () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const { relay: host } = relay(runs(worker));
      const a = window(1);
      host.subscribe(a.connection, RUN);
      a.setBuffered(WINDOW_BUFFER_LIMIT);
      worker.frame(1, 0);
      a.connection.notify('run.event', { seq: 1 });
      expect(a.binary).toHaveLength(0);
      a.setBuffered(0);
      vi.advanceTimersByTime(25);
      expect(a.order).toEqual(['run.event', 'frame']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('delivers a valid binary payload the app can decode', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    host.subscribe(a.connection, RUN);
    worker.frame(3, 9, 128);
    const decoded = decodeFramePayload(a.binary[0]!);
    expect(decoded).not.toBeInstanceOf(Error);
    if (decoded instanceof Error) return;
    expect(decoded.meta).toMatchObject({ generation: 3, frame_seq: 9 });
    expect(decoded.jpeg).toHaveLength(128);
  });
});

describe('@no-llm live-view relay: lifecycle', () => {
  it('starts the worker with the first window and stops it with the last', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    const a = window(1);
    const b = window(2);
    host.subscribe(a.connection, RUN);
    host.subscribe(b.connection, RUN);
    host.subscribe(b.connection, RUN);
    expect(worker.types()).toEqual(['frames.start']);
    host.unsubscribe(1, RUN);
    expect(worker.types()).toEqual(['frames.start']);
    b.close();
    expect(worker.types()).toEqual(['frames.start', 'frames.stop']);
    expect(worker.listening).toBe(0);
    expect(host.watchedRuns()).toEqual([]);
  });

  it('refuses a run that is not attached', () => {
    const { relay: host } = relay(runs(new FakeWorker()));
    expect(() => host.subscribe(window(1).connection, 'other-run')).toThrow(/not attached/u);
  });

  it('reports an owner without frames/1 as incompatible, and never starts it', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker, { capabilities: ['events'] }));
    expect(host.subscribe(window(1).connection, RUN)).toMatchObject({
      state: 'unavailable',
      reason: 'incompatible_worker',
    });
    expect(worker.sent).toEqual([]);
  });

  it('reports an owner of another channel version as incompatible', () => {
    const { relay: host } = relay(runs(null, { channel: 'live_unavailable' }));
    expect(host.subscribe(window(1).connection, RUN)).toMatchObject({
      state: 'unavailable',
      reason: 'incompatible_worker',
    });
  });

  it('reports a run with no live owner as no_page', () => {
    const { relay: host } = relay(runs(null));
    expect(host.subscribe(window(1).connection, RUN)).toMatchObject({ state: 'no_page' });
  });

  it('upgrades a watch that began while the worker was still attaching', () => {
    const worker = new FakeWorker();
    let attached = false;
    const source: LiveViewRunSource = {
      owner: (runId) =>
        runId !== RUN
          ? null
          : attached
            ? {
                channel: 'live',
                live: { client: worker.client, capabilities: [FRAMES_CAPABILITY] },
              }
            : { channel: 'replay_only', live: null },
    };
    const { relay: host } = relay(source);
    const a = window(1);
    expect(host.subscribe(a.connection, RUN)).toMatchObject({ state: 'no_page' });
    expect(worker.sent).toEqual([]);
    attached = true;
    host.runAttached(RUN);
    expect(worker.types()).toEqual(['frames.start']);
    expect(a.notes.at(-1)?.[0]).toBe('frames.state');
    worker.frame(1, 0);
    expect(a.seqs()).toEqual([0]);
    host.runAttached(RUN);
    const lifecycle = () => worker.types().filter((type) => type !== 'frame.ack');
    expect(lifecycle()).toEqual(['frames.start']);
    a.close();
    expect(lifecycle()).toEqual(['frames.start', 'frames.stop']);
  });

  it('ignores an attach for a run nobody watches', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    host.runAttached(RUN);
    expect(worker.sent).toEqual([]);
  });

  it('drops the run when the run relay detaches it', () => {
    const worker = new FakeWorker();
    const { relay: host } = relay(runs(worker));
    host.subscribe(window(1).connection, RUN);
    host.runDetached(RUN);
    expect(host.watchedRuns()).toEqual([]);
    expect(worker.listening).toBe(0);
  });

  it('logs subscriptions with counts only, never frame bytes or titles', () => {
    const worker = new FakeWorker();
    const { relay: host, info } = relay(runs(worker));
    const a = window(1);
    host.subscribe(a.connection, RUN);
    worker.message({
      type: 'frames.state',
      generation: 1,
      state: 'live',
      reason: 'none',
      page: { host: 'mail.example', title: 'Secret inbox title' },
    });
    worker.frame(1, 0);
    host.unsubscribe(1, RUN);
    const logged = JSON.stringify(info.mock.calls);
    expect(info).toHaveBeenCalledWith({ run_id: RUN, windows: 1 }, 'live view subscribed');
    expect(info).toHaveBeenCalledWith({ run_id: RUN, windows: 0 }, 'live view unsubscribed');
    expect(logged).not.toContain('Secret inbox title');
    expect(logged).not.toContain('mail.example');
  });

  it('registers frames.subscribe, frames.unsubscribe and frames.ack', () => {
    const methods = new RpcMethodRegistry();
    relay(runs(new FakeWorker())).relay.register(methods);
    for (const name of ['frames.subscribe', 'frames.unsubscribe', 'frames.ack']) {
      expect(methods.get(name)).toBeDefined();
    }
  });
});
