import { describe, expect, it } from 'vitest';

import { logEntries } from '../../../src/features/live/bounded-log.js';
import { initialCockpitState, reduceRunEvents } from '../../../src/features/live/cockpit-state.js';
import {
  createRunStream,
  type ConnectionSource,
  type StreamClock,
} from '../../../src/features/live/run-stream.js';
import type { ConnectionState } from '../../../src/host/connection-store.js';
import { FakeRpc } from '../../support/fake-rpc.js';
import { ev, numbered } from '../../support/run-events.js';

/** A frame clock the test steps by hand. */
class SteppedFrames implements StreamClock {
  private pending: (() => void)[] = [];

  public frame(callback: () => void): () => void {
    this.pending.push(callback);
    return () => {
      this.pending = this.pending.filter((item) => item !== callback);
    };
  }

  public get waiting(): number {
    return this.pending.length;
  }

  public step(): void {
    const due = this.pending;
    this.pending = [];
    for (const callback of due) callback();
  }
}

class FakeConnection implements ConnectionSource {
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

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const EVENTS = [
  ev('goal_echo'),
  ev('contract_declared'),
  ev('tool_started'),
  ev('progress'),
  ev('tool_finished'),
  ev('budget_snapshot'),
  ev('tool_started', { tool: 'browser_click' }),
  ev('tool_finished', { tool: 'browser_click' }),
  ev('run_outcome'),
];

/** A relay that replays `events` from the requested seq, as the host does. */
function fakeRelay(
  rpc: FakeRpc,
  events: readonly unknown[],
  options: { readonly channel?: string; readonly upTo?: () => number } = {},
): void {
  rpc.answer('run.subscribe', (params) => {
    const from = params.from_seq as number;
    const upTo = options.upTo?.() ?? events.length;
    for (const { seq, event } of numbered(events)) {
      if (seq >= from && seq <= upTo)
        rpc.notify('run.event', { run_id: params.run_id, seq, event });
    }
    return { channel: options.channel ?? 'live' };
  });
  rpc.answer('run.unsubscribe', {});
}

function straightReplay(events: readonly unknown[]) {
  return reduceRunEvents(initialCockpitState('run-1'), numbered(events)).state;
}

describe('@no-llm run stream', () => {
  it('subscribes from seq 1 and applies a replay once per frame', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, EVENTS);
    const frames = new SteppedFrames();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames });
    let renders = 0;
    stream.subscribe(() => {
      renders += 1;
    });

    stream.start();
    await settle();
    const before = renders;
    frames.step();

    expect(rpc.paramsOf('run.subscribe')).toEqual([{ run_id: 'run-1', from_seq: 1 }]);
    expect(renders - before).toBe(1);
    expect(stream.getSnapshot().cockpit).toEqual(straightReplay(EVENTS));
    expect(stream.getSnapshot().channel).toEqual({ state: 'live' });
  });

  it('applies nothing until the frame runs', () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, EVENTS);
    const frames = new SteppedFrames();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames });

    stream.start();

    expect(stream.getSnapshot().cockpit.lastSeq).toBe(0);
    expect(frames.waiting).toBe(1);
  });

  it('resubscribes from lastSeq + 1 on a gap and ends equal to a straight replay', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, EVENTS);
    const frames = new SteppedFrames();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames });
    rpc.answer('run.subscribe', (params) => {
      if ((params.from_seq as number) === 1) {
        // The relay skips seq 3 on the first pass.
        for (const { seq, event } of numbered(EVENTS)) {
          if (seq !== 3) rpc.notify('run.event', { run_id: 'run-1', seq, event });
        }
      } else {
        for (const { seq, event } of numbered(EVENTS)) {
          if (seq >= (params.from_seq as number))
            rpc.notify('run.event', { run_id: 'run-1', seq, event });
        }
      }
      return { channel: 'live' };
    });

    stream.start();
    await settle();
    frames.step();
    await settle();
    frames.step();

    expect(rpc.paramsOf('run.subscribe').map((params) => params.from_seq)).toEqual([1, 3]);
    expect(stream.getSnapshot().cockpit).toEqual(straightReplay(EVENTS));
  });

  it('resubscribes after a reconnect with no duplicate timeline rows', async () => {
    const rpc = new FakeRpc();
    let available = 4;
    fakeRelay(rpc, EVENTS, { upTo: () => available });
    const frames = new SteppedFrames();
    const connection = new FakeConnection();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames, connection });

    stream.start();
    await settle();
    frames.step();
    connection.set({ status: 'disconnected', retryAt: 0 });
    available = EVENTS.length;
    connection.set({ status: 'connected' });
    await settle();
    frames.step();

    const cockpit = stream.getSnapshot().cockpit;
    expect(rpc.paramsOf('run.subscribe').map((params) => params.from_seq)).toEqual([1, 5]);
    expect(cockpit).toEqual(straightReplay(EVENTS));
    expect(logEntries(cockpit.timeline).map((row) => row.seq)).toEqual([3, 7]);
  });

  it('yields the uninterrupted replay after stopping and restarting mid-stream', async () => {
    const rpc = new FakeRpc();
    let available = 5;
    fakeRelay(rpc, EVENTS, { upTo: () => available });
    const frames = new SteppedFrames();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames });

    stream.start();
    await settle();
    frames.step();
    stream.stop();
    rpc.notify('run.event', { run_id: 'run-1', seq: 6, event: EVENTS[5] });
    available = EVENTS.length;
    stream.start();
    await settle();
    frames.step();

    expect(rpc.paramsOf('run.unsubscribe')).toEqual([{ run_id: 'run-1' }]);
    expect(rpc.paramsOf('run.subscribe').map((params) => params.from_seq)).toEqual([1, 6]);
    expect(stream.getSnapshot().cockpit).toEqual(straightReplay(EVENTS));
  });

  it('ignores events of other runs', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, []);
    const frames = new SteppedFrames();
    const stream = createRunStream({ rpc, runId: 'run-1', clock: frames });

    stream.start();
    await settle();
    rpc.notify('run.event', { run_id: 'run-2', seq: 1, event: EVENTS[0] });
    rpc.notify('run.event', { run_id: 'run-1', seq: 'x', event: EVENTS[0] });
    frames.step();

    expect(stream.getSnapshot().cockpit.lastSeq).toBe(0);
    expect(frames.waiting).toBe(0);
  });

  it('follows the worker channel: not responding, recovered and unavailable', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, []);
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    await settle();
    rpc.notify('run.channel', { run_id: 'run-1', state: 'not_responding' });
    const silent = stream.getSnapshot().channel;
    rpc.notify('run.channel', { run_id: 'run-1', state: 'recovered' });
    const back = stream.getSnapshot().channel;
    rpc.notify('run.channel', { run_id: 'run-2', state: 'not_responding' });
    rpc.notify('run.channel', {
      run_id: 'run-1',
      state: 'live_unavailable',
      worker_version: '0.9.0',
    });

    expect(silent).toEqual({ state: 'not_responding' });
    expect(back).toEqual({ state: 'live' });
    expect(stream.getSnapshot().channel).toEqual({
      state: 'unavailable',
      startedByVersion: '0.9.0',
    });
  });

  it('keeps the worker version when the subscribe answer arrives after the notice', async () => {
    const rpc = new FakeRpc();
    rpc.answer('run.subscribe', (params) => {
      rpc.notify('run.channel', {
        run_id: params.run_id,
        state: 'live_unavailable',
        worker_version: '0.9.0',
      });
      return { channel: 'live_unavailable' };
    });
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    await settle();

    expect(stream.getSnapshot().channel).toEqual({
      state: 'unavailable',
      startedByVersion: '0.9.0',
    });
  });

  it('reports a run served only from its file', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, EVENTS, { channel: 'replay_only' });
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    await settle();

    expect(stream.getSnapshot().channel).toEqual({ state: 'replay_only' });
  });

  it('reports a subscribe failure and clears it on a later success', async () => {
    const rpc = new FakeRpc();
    let fail = true;
    rpc.answer('run.subscribe', () => {
      if (fail) throw new Error('There is no run run-1.');
      return { channel: 'live' };
    });
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    await settle();
    const failed = stream.getSnapshot().error;
    fail = false;
    stream.resubscribe();
    await settle();

    expect(failed).toBe('There is no run run-1.');
    expect(stream.getSnapshot().error).toBeNull();
  });

  it('starts once however often start is called', async () => {
    const rpc = new FakeRpc();
    fakeRelay(rpc, []);
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    stream.start();
    await settle();
    stream.stop();
    stream.stop();

    expect(rpc.paramsOf('run.subscribe')).toHaveLength(1);
    expect(rpc.paramsOf('run.unsubscribe')).toHaveLength(1);
  });

  it('ignores the answer of a subscribe made before stop', async () => {
    const rpc = new FakeRpc();
    let release: (value: unknown) => void = () => undefined;
    rpc.answer('run.subscribe', () => new Promise((resolve) => (release = resolve)));
    rpc.answer('run.unsubscribe', {});
    const stream = createRunStream({ rpc, runId: 'run-1', clock: new SteppedFrames() });

    stream.start();
    stream.stop();
    release({ channel: 'replay_only' });
    await settle();

    expect(stream.getSnapshot().channel).toEqual({ state: 'connecting' });
  });
});
