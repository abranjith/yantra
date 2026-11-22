// @no-llm
/**
 * Attendance (FEAT-065 TASK-018, D5): only a connected, subscribed window
 * with a fresh heartbeat counts, and workers always get the current count.
 */

import { join } from 'node:path';

import { runsRoot } from '@yantra/core';
import type { DecisionResponse } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  ATTENDANCE_TTL_MS,
  Attendance,
  type AttendanceDeps,
} from '../../../src/ui/host/attendance.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
  type RpcConnection,
} from '../../../src/ui/host/rpc-server.js';
import { RunRelay, type RelayClient } from '../../../src/ui/host/run-relay.js';

function connection(id: number) {
  const closers: (() => void)[] = [];
  const sent: [string, Record<string, unknown>][] = [];
  const value: RpcConnection = {
    id,
    windowId: `w${id}`,
    notify: (method, params) => sent.push([method, params]),
    onClose: (listener) => closers.push(listener),
  };
  return { value, sent, close: () => closers.forEach((closer) => closer()) };
}

function setup() {
  let now = 1_000_000;
  const broadcasts: number[] = [];
  const direct: [string, number][] = [];
  const attendance = new Attendance({
    broadcast: (count) => broadcasts.push(count),
    sendTo: (runId, count) => direct.push([runId, count]),
    now: () => now,
  });
  const methods = new RpcMethodRegistry();
  attendance.register(methods);
  const call = (method: string, conn: RpcConnection) =>
    methods
      .get(method)!
      .handler({}, { windowId: conn.windowId, connection: conn } as RpcCallContext);
  return {
    attendance,
    broadcasts,
    direct,
    call,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the count', () => {
  it('is 1 for one subscribed window with fresh heartbeats, and 0 at 30 s plus 1 ms', async () => {
    // Arrange
    const env = setup();
    const a = connection(1);
    await env.call('interventions.subscribe', a.value);

    // Act / Assert
    env.advance(20_000);
    await env.call('attendance.heartbeat', a.value);
    env.advance(ATTENDANCE_TTL_MS);
    expect(env.attendance.count()).toBe(1);
    env.advance(1);
    expect(env.attendance.count()).toBe(0);
  });

  it('is 0 for a connected window that never subscribed', async () => {
    const env = setup();
    const a = connection(1);
    await env.call('attendance.heartbeat', a.value);
    expect(env.attendance.count()).toBe(0);
  });

  it('is 0 with zero windows, whatever the host or queue holds', () => {
    const env = setup();
    expect(env.attendance.count()).toBe(0);
    expect(env.attendance.refresh()).toBe(0);
  });

  it('drops a window when its socket closes, and tells the workers', async () => {
    const env = setup();
    const a = connection(1);
    await env.call('interventions.subscribe', a.value);
    a.close();
    expect(env.attendance.count()).toBe(0);
    expect(env.broadcasts).toEqual([1, 0]);
  });

  it('broadcasts only on change', async () => {
    const env = setup();
    const a = connection(1);
    await env.call('interventions.subscribe', a.value);
    await env.call('attendance.heartbeat', a.value);
    await env.call('attendance.heartbeat', a.value);
    expect(env.broadcasts).toEqual([1]);
  });
});

describe('workers', () => {
  it('get the current count the moment they attach', async () => {
    // Arrange: a window attends; then the relay attaches a run.
    const env = setup();
    const a = connection(1);
    await env.call('interventions.subscribe', a.value);
    const sends: unknown[] = [];
    const client: RelayClient = {
      connect: () => Promise.resolve({ state: 'attached', capabilities: [], channelVersion: 1 }),
      subscribe: () => undefined,
      onEvent: () => () => undefined,
      getSnapshot: () => ({ state: 'attached', lastSeq: 0, ownerVersion: null }),
      subscribeSnapshot: () => () => undefined,
      send: (message) => sends.push(message),
      close: () => undefined,
    };
    const relay = new RunRelay({
      runsRoot: '/runs',
      createClient: () => client,
      readEvents: async function* () {
        // No events in this test.
      } as never,
      readLease: () => Promise.resolve({ kind: 'lease', lease: {} as never }),
      onAttach: (runId) => {
        relay.sendToWorker(runId, { type: 'attendance', count: env.attendance.count() });
      },
    });

    // Act
    await relay.follow(connection(2).value, 'run-1', 1);

    // Assert
    expect(sends).toEqual([{ type: 'attendance', count: 1 }]);
  });

  it('attached() sends the count to that worker', () => {
    const env = setup();
    env.attendance.attached('run-9');
    expect(env.direct).toEqual([['run-9', 0]]);
  });
});

describe('interventions', () => {
  it('forwards intervention events of attached runs to subscribed windows only', async () => {
    const env = setup();
    const a = connection(1);
    const b = connection(2);
    await env.call('interventions.subscribe', a.value);
    env.attendance.forward('run-1', 4, { kind: 'intervention_raised', id: 'i1' });
    env.attendance.forward('run-1', 5, { kind: 'step_started' });
    expect(a.sent).toEqual([
      [
        'intervention.event',
        { run_id: 'run-1', seq: 4, event: { kind: 'intervention_raised', id: 'i1' } },
      ],
    ]);
    expect(b.sent).toEqual([]);
  });
});

describe('intervention.answer (REV-001)', () => {
  const RUN_ID = '20261121T100000Z-shop-0000abcd';
  const ID = '01J00000000000000000000001';
  const accepted: DecisionResponse = {
    status: 'accepted',
    decision: {
      confirmation_id: ID,
      decision: 'granted',
      decided_at: '2026-11-21T10:00:00.000Z',
      decided_by: 'user_app',
    },
  };

  function answering(
    answerLive: AttendanceDeps['answerLive'],
    decide: AttendanceDeps['decide'] = vi.fn(),
  ) {
    const attendance = new Attendance({
      broadcast: () => undefined,
      sendTo: () => undefined,
      ...(answerLive === undefined ? {} : { answerLive }),
      decide,
    });
    const methods = new RpcMethodRegistry();
    attendance.register(methods);
    const conn = connection(1).value;
    const answer = (decision: 'granted' | 'denied' = 'granted') =>
      methods
        .get('intervention.answer')!
        .handler({ run_id: RUN_ID, intervention_id: ID, decision }, {
          windowId: conn.windowId,
          connection: conn,
        } as RpcCallContext);
    return { answer, decide };
  }

  it("returns the attached owner's response and never touches the parked path", async () => {
    const env = answering(() => Promise.resolve(accepted));
    await expect(env.answer()).resolves.toEqual(accepted);
    expect(env.decide).not.toHaveBeenCalled();
  });

  it('fails with owner_unreachable when the attached owner does not reply, deciding nothing', async () => {
    const env = answering(() => Promise.resolve('no_response'));
    const failure = env.answer();
    await expect(failure).rejects.toBeInstanceOf(RpcError);
    await expect(failure).rejects.toMatchObject({ data: { code: 'owner_unreachable' } });
    expect(env.decide).not.toHaveBeenCalled();
  });

  it.each([
    ['not attached', () => Promise.resolve('not_attached' as const)],
    ['without a relay', undefined],
  ])(
    'when %s, decides through the shared path for exactly the answered request',
    async (_label, answerLive) => {
      const decide = vi.fn(() =>
        Promise.resolve({ kind: 'decided' as const, case: 'parked' as const, response: accepted }),
      );
      const env = answering(answerLive, decide);

      await expect(env.answer('denied')).resolves.toEqual(accepted);

      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith({
        runDir: join(runsRoot(), RUN_ID),
        runId: RUN_ID,
        confirmationId: ID,
        decision: 'denied',
        decidedBy: 'user_app',
      });
    },
  );

  it('fails with owner_unreachable when an unattached live owner cannot be reached', async () => {
    const decide = vi.fn(() =>
      Promise.resolve({ kind: 'owner_unreachable' as const, reason: 'unreachable' as const }),
    );
    const env = answering(() => Promise.resolve('not_attached'), decide);
    await expect(env.answer()).rejects.toMatchObject({
      code: -32002,
      data: { code: 'owner_unreachable' },
    });
  });
});
