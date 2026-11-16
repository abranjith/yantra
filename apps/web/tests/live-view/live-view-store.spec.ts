// @no-llm
/**
 * The live-view store (FEAT-069 TASK-010): protection clears synchronously,
 * the floor is re-checked at draw time, every frame is acked, and a lost
 * connection drops the image.
 */

import { encodeFramePayload, type ScreencastFrameMeta } from '@yantra/protocol/screencast';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectionState } from '../../src/host/connection-store.js';
import {
  LiveViewStore,
  type DrawableImage,
  type LiveViewCanvas,
  type LiveViewConnection,
} from '../../src/live-view/live-view-store.js';
import { FakeRpc } from '../support/fake-rpc.js';

const RUN = '20261115T100000Z-do-0000abcd';

class BinaryRpc extends FakeRpc {
  private readonly binary = new Set<(bytes: ArrayBuffer) => void>();
  public onBinary(handler: (bytes: ArrayBuffer) => void): () => void {
    this.binary.add(handler);
    return () => this.binary.delete(handler);
  }
  public frame(meta: Partial<ScreencastFrameMeta> = {}): void {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2]);
    const bytes = encodeFramePayload(
      {
        generation: 1,
        frame_seq: 0,
        document_epoch: 1,
        captured_at: '2026-11-15T10:00:00.000Z',
        width: 4,
        height: 3,
        ...meta,
      },
      jpeg,
    );
    const copy = bytes.slice().buffer;
    for (const handler of this.binary) handler(copy);
  }
  public raw(bytes: Uint8Array): void {
    for (const handler of this.binary) handler(bytes.slice().buffer);
  }
}

class FakeCanvas implements LiveViewCanvas {
  public width = 0;
  public height = 0;
  public readonly ops: string[] = [];
  public getContext() {
    return {
      clearRect: () => this.ops.push('clear'),
      drawImage: () => this.ops.push('draw'),
    };
  }
}

class FakeConnection implements LiveViewConnection {
  private state: ConnectionState = { status: 'connected' };
  private readonly listeners = new Set<() => void>();
  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  public getSnapshot(): ConnectionState {
    return this.state;
  }
  public set(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

/** A decoder whose results the test releases by hand. */
function deferredDecoder() {
  const pending: {
    resolve: (image: DrawableImage) => void;
    image: DrawableImage & { closed: boolean };
  }[] = [];
  return {
    pending,
    decode: () =>
      new Promise<DrawableImage>((resolve) => {
        const image = {
          width: 4,
          height: 3,
          closed: false,
          close() {
            image.closed = true;
          },
        };
        pending.push({ resolve, image });
      }),
    release: (index = 0) => {
      const entry = pending[index]!;
      entry.resolve(entry.image);
      return entry.image;
    },
  };
}

const LIVE_STATE = {
  generation: 1,
  state: 'live',
  reason: 'none',
  page: { host: 'a.test', title: 'A' },
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function started(options: { decoder?: ReturnType<typeof deferredDecoder> } = {}) {
  const rpc = new BinaryRpc()
    .answer('frames.subscribe', LIVE_STATE)
    .answer('frames.ack', {})
    .answer('frames.unsubscribe', {});
  const connection = new FakeConnection();
  const canvas = new FakeCanvas();
  const decoder = options.decoder ?? deferredDecoder();
  const samples: string[] = [];
  const store = new LiveViewStore({
    rpc,
    runId: RUN,
    connection,
    decodeImage: decoder.decode,
    onSample: (sample) => samples.push(sample.kind),
  });
  store.start();
  store.attachCanvas(canvas);
  await flush();
  return { rpc, store, canvas, decoder, connection, samples };
}

describe('LiveViewStore', () => {
  it('subscribes for its run and takes the state the host returns', async () => {
    const { rpc, store } = await started();
    expect(rpc.paramsOf('frames.subscribe')).toEqual([{ run_id: RUN }]);
    expect(store.getSnapshot()).toMatchObject({
      state: 'live',
      page: { host: 'a.test', title: 'A' },
      generationFloor: 1,
    });
  });

  it('draws a frame, then acks it', async () => {
    const { rpc, store, canvas, decoder, samples } = await started();
    rpc.frame({ frame_seq: 3 });
    await flush();
    decoder.release();
    await flush();
    expect(canvas.ops).toContain('draw');
    expect([canvas.width, canvas.height]).toEqual([4, 3]);
    expect(store.getSnapshot().lastDrawn).toEqual({ generation: 1, frame_seq: 3 });
    expect(rpc.paramsOf('frames.ack')).toEqual([{ run_id: RUN, generation: 1, frame_seq: 3 }]);
    expect(samples).toEqual(['offered', 'drawn']);
  });

  it('clears the canvas and shows protected in the same tick as frames.cleared', async () => {
    const { rpc, store, canvas } = await started();
    canvas.ops.length = 0;
    rpc.notify('frames.cleared', { run_id: RUN, generation: 2, reason: 'protection' });
    expect(canvas.ops).toEqual(['clear']);
    expect(store.getSnapshot()).toMatchObject({
      state: 'protected',
      page: null,
      generationFloor: 2,
    });
  });

  it('closes, never draws, a decode of the older generation that finishes after frames.cleared', async () => {
    const { rpc, canvas, decoder } = await started();
    rpc.frame({ generation: 1, frame_seq: 0 });
    await flush();
    rpc.notify('frames.cleared', { run_id: RUN, generation: 2, reason: 'protection' });
    const image = decoder.release();
    await flush();
    expect(image.closed).toBe(true);
    expect(canvas.ops).not.toContain('draw');
    expect(rpc.paramsOf('frames.ack')).toEqual([{ run_id: RUN, generation: 1, frame_seq: 0 }]);
  });

  it('drops and acks a frame below the floor without decoding it', async () => {
    const { rpc, decoder } = await started();
    rpc.notify('frames.state', { run_id: RUN, ...LIVE_STATE, generation: 5 });
    rpc.frame({ generation: 4, frame_seq: 7 });
    await flush();
    expect(decoder.pending).toHaveLength(0);
    expect(rpc.paramsOf('frames.ack')).toEqual([{ run_id: RUN, generation: 4, frame_seq: 7 }]);
  });

  it('does not draw while the view is not live', async () => {
    const { rpc, decoder, canvas } = await started();
    rpc.notify('frames.state', {
      run_id: RUN,
      generation: 1,
      state: 'headed',
      reason: 'none',
      page: null,
    });
    rpc.frame({ generation: 1, frame_seq: 1 });
    await flush();
    expect(decoder.pending).toHaveLength(0);
    expect(canvas.ops).toContain('clear');
  });

  it('ignores notifications for another run and malformed ones', async () => {
    const { rpc, store } = await started();
    rpc.notify('frames.cleared', { run_id: 'other', generation: 9, reason: 'protection' });
    rpc.notify('frames.cleared', { run_id: RUN, generation: 9, reason: 'nope' });
    rpc.notify('frames.state', {
      run_id: RUN,
      generation: 1,
      state: 'weird',
      reason: 'none',
      page: null,
    });
    expect(store.getSnapshot()).toMatchObject({ state: 'live', generationFloor: 1 });
  });

  it('ignores a malformed binary payload', async () => {
    const { rpc, decoder } = await started();
    rpc.raw(new Uint8Array([0, 1, 2]));
    await flush();
    expect(decoder.pending).toHaveLength(0);
    expect(rpc.paramsOf('frames.ack')).toEqual([]);
  });

  it('drops the image on disconnect, shows reconnecting, and resubscribes on reconnect', async () => {
    const { rpc, store, canvas, connection } = await started();
    canvas.ops.length = 0;
    connection.set({ status: 'disconnected', retryAt: 0 });
    expect(canvas.ops).toEqual(['clear']);
    expect(store.getSnapshot()).toMatchObject({
      state: 'reconnecting',
      page: null,
      lastDrawn: null,
    });
    rpc.answer('frames.subscribe', {
      ...LIVE_STATE,
      state: 'protected',
      page: null,
      generation: 3,
    });
    connection.set({ status: 'connected' });
    await flush();
    expect(rpc.paramsOf('frames.subscribe')).toHaveLength(2);
    expect(store.getSnapshot()).toMatchObject({ state: 'protected', generationFloor: 3 });
  });

  it('shows unavailable when the host refuses the subscription', async () => {
    const rpc = new BinaryRpc();
    const store = new LiveViewStore({ rpc, runId: RUN });
    store.start();
    await flush();
    expect(store.getSnapshot().state).toBe('unavailable');
  });

  it('notifies subscribers on each change', async () => {
    const { rpc, store } = await started();
    const listener = vi.fn();
    store.subscribe(listener);
    rpc.notify('frames.cleared', { run_id: RUN, generation: 2, reason: 'protection' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops: handlers removed, canvas cleared, host told', async () => {
    const { rpc, store, canvas } = await started();
    store.stop();
    store.stop();
    rpc.notify('frames.cleared', { run_id: RUN, generation: 9, reason: 'protection' });
    expect(store.getSnapshot().generationFloor).toBe(1);
    expect(canvas.ops).toContain('clear');
    expect(rpc.paramsOf('frames.unsubscribe')).toEqual([{ run_id: RUN }]);
  });
});
