// @no-llm
/**
 * The stop service (FEAT-064 TASK-011): cancel, grace, identity-verified
 * forced termination, always reconcile.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunLease } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { CancelAck, ChannelConnectResult } from '../../src/run-channel/client.js';
import { STOP_GRACE_MS } from '../../src/run-ownership/constants.js';
import { claimLease, releaseLease } from '../../src/run-ownership/lease-store.js';
import type { ReconcileResult } from '../../src/run-ownership/reconciler.js';
import { stopRun, type StopChannel, type StopDeps } from '../../src/run-ownership/stop-run.js';

import { OWNER, TableProbe, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

const OWNER_KEY = `${OWNER.pid}:${OWNER.startToken}`;
const RECONCILED: ReconcileResult = {
  kind: 'reconciled',
  outcome: 'failed',
  evidence: 'owner_lost',
  reaped: 0,
  uncertain: 0,
};

async function ownedRun(): Promise<string> {
  const runDir = makeTempDir();
  await claimLease(runDir, claimInit(), { identity: OWNER });
  return runDir;
}

/**
 * A stepped clock: time moves only when the stop sleeps. Each sleep still
 * yields to the event loop, so real file I/O keeps pace with the clock.
 */
function steppedClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

interface FakeChannelScript {
  readonly connect?: ChannelConnectResult;
  /** What cancel resolves to; `'never'` never resolves. */
  readonly ack?: CancelAck | null | 'never';
  /** Runs when cancel is sent (a cooperative owner ends its run here). */
  readonly onCancel?: () => Promise<void>;
}

function fakeChannel(script: FakeChannelScript): { factory: () => StopChannel; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    factory: () => ({
      connect: (_lease: RunLease) => {
        sent.push('hello');
        return Promise.resolve(
          script.connect ?? { state: 'attached', capabilities: ['cancel'], channelVersion: 1 },
        );
      },
      cancel: async () => {
        sent.push('cancel');
        await script.onCancel?.();
        if (script.ack === 'never') return new Promise<CancelAck | null>(() => undefined);
        return script.ack === undefined ? { alreadyCancelling: false, honored: true } : script.ack;
      },
      close: () => undefined,
    }),
  };
}

function deps(
  overrides: Partial<StopDeps> & { probe?: TableProbe },
): StopDeps & { terminated: number[]; reconciled: number } {
  const clock = steppedClock();
  const state = { terminated: [] as number[], reconciled: 0 };
  const probe = overrides.probe ?? new TableProbe({ [OWNER_KEY]: 'alive' });
  return Object.assign(state, {
    probe,
    terminator: {
      terminate: (pid: number) => {
        state.terminated.push(pid);
        probe.set(OWNER, 'dead');
        return Promise.resolve();
      },
    },
    reconcile: () => {
      state.reconciled += 1;
      return Promise.resolve(RECONCILED);
    },
    ...clock,
    ...overrides,
  });
}

describe('@no-llm stopRun', () => {
  it('reports not_running when there is no lease', async () => {
    expect(await stopRun({ runDir: makeTempDir() }, deps({}))).toEqual({ kind: 'not_running' });
  });

  it('stops a cooperative owner gracefully, never calling the terminator', async () => {
    const runDir = await ownedRun();
    writeFileSync(join(runDir, 'manifest.json'), JSON.stringify({ taskOutcome: 'aborted' }));
    const channel = fakeChannel({
      onCancel: async () => {
        await releaseLease(runDir, { evidenceFlushed: true });
      },
    });
    const used = deps({ channel: channel.factory });
    expect(await stopRun({ runDir }, used)).toEqual({
      kind: 'stopped_gracefully',
      outcome: 'aborted',
    });
    expect(used.terminated).toEqual([]);
    expect(used.reconciled).toBe(0);
  });

  it('terminates an owner that ignores cancel after exactly the grace period, then reconciles', async () => {
    const runDir = await ownedRun();
    const clock = steppedClock();
    let terminatedAt = -1;
    const probe = new TableProbe({ [OWNER_KEY]: 'alive' });
    const used = deps({
      channel: fakeChannel({}).factory,
      probe,
      ...clock,
      terminator: {
        terminate: (pid) => {
          terminatedAt = clock.now();
          used.terminated.push(pid);
          probe.set(OWNER, 'dead');
          return Promise.resolve();
        },
      },
    });
    expect(await stopRun({ runDir }, used)).toEqual({
      kind: 'stopped_forcefully',
      reconcile: RECONCILED,
    });
    expect(terminatedAt).toBe(STOP_GRACE_MS);
    expect(used.terminated).toEqual([OWNER.pid]);
    expect(used.reconciled).toBe(1);
  });

  it('gives an owner that never acknowledges cancel only the grace period', async () => {
    const runDir = await ownedRun();
    const used = deps({ channel: fakeChannel({ ack: 'never' }).factory });
    expect((await stopRun({ runDir }, used)).kind).toBe('stopped_forcefully');
    expect(used.terminated).toEqual([OWNER.pid]);
  });

  it('terminates at once when the owner answers honored: false', async () => {
    const runDir = await ownedRun();
    const clock = steppedClock();
    let terminatedAt = -1;
    const probe = new TableProbe({ [OWNER_KEY]: 'alive' });
    const used = deps({
      channel: fakeChannel({ ack: { alreadyCancelling: false, honored: false } }).factory,
      probe,
      ...clock,
      terminator: {
        terminate: () => {
          terminatedAt = clock.now();
          probe.set(OWNER, 'dead');
          return Promise.resolve();
        },
      },
    });
    expect((await stopRun({ runDir }, used)).kind).toBe('stopped_forcefully');
    // No grace wait: at most the one poll interval already in flight.
    expect(terminatedAt).toBeGreaterThanOrEqual(0);
    expect(terminatedAt).toBeLessThanOrEqual(100);
  });

  it('never signals an owner whose identity is unknown', async () => {
    const runDir = await ownedRun();
    const used = deps({
      channel: fakeChannel({ connect: { state: 'unreachable' } }).factory,
      probe: new TableProbe({ [OWNER_KEY]: 'unknown' }),
    });
    expect(await stopRun({ runDir }, used)).toEqual({
      kind: 'stop_unverifiable',
      pid: OWNER.pid,
    });
    expect(used.terminated).toEqual([]);
    expect(used.reconciled).toBe(0);
  });

  it('never signals a reused PID (dead verdict) and still reconciles', async () => {
    const runDir = await ownedRun();
    const used = deps({
      channel: fakeChannel({ connect: { state: 'unreachable' } }).factory,
      probe: new TableProbe({ [OWNER_KEY]: 'dead' }),
    });
    expect((await stopRun({ runDir }, used)).kind).toBe('stopped_forcefully');
    expect(used.terminated).toEqual([]);
    expect(used.reconciled).toBe(1);
  });

  it('reconciles even when terminate throws', async () => {
    const runDir = await ownedRun();
    const used = deps({
      channel: fakeChannel({ connect: { state: 'unreachable' } }).factory,
      terminator: { terminate: () => Promise.reject(new Error('access denied')) },
    });
    expect((await stopRun({ runDir }, used)).kind).toBe('stopped_forcefully');
    expect(used.reconciled).toBe(1);
  });

  it('stops an incompatible owner by identity, without ever sending it cancel', async () => {
    const runDir = await ownedRun();
    const channel = fakeChannel({ connect: { state: 'live_unavailable', ownerVersion: '0.0.9' } });
    const used = deps({ channel: channel.factory });
    expect((await stopRun({ runDir }, used)).kind).toBe('stopped_forcefully');
    expect(channel.sent).toEqual(['hello']);
    expect(used.terminated).toEqual([OWNER.pid]);
  });
});
