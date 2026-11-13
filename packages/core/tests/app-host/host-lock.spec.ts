// @no-llm
/**
 * The app host's single-instance lock (FEAT-065 TASK-001).
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HostLockRecord } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostLockHeldError } from '../../src/app-host/errors.js';
import { FileHostLock, type HostLockMetadata } from '../../src/app-host/host-lock.js';
import type {
  LivenessVerdict,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../../src/browser/installation-types.js';
import {
  hostLogPath,
  invocationPath,
  invocationResultPath,
  invocationsRoot,
  slotsLockPath,
  uiChromeProfilePath,
  uiHostLockPath,
  uiRoot,
  workerLaunchRoot,
} from '../../src/browser/paths.js';
import { resetPathCache } from '../../src/config/resolved-paths.js';
import { uniqueTempPath } from '../../src/fs/atomic-write.js';

/** Answers from a table keyed by `pid:startToken`, default `dead`. */
class TableProbe implements ProcessLivenessProbe {
  public readonly table = new Map<string, LivenessVerdict>();

  public set(identity: ProcessIdentity, verdict: LivenessVerdict): void {
    this.table.set(`${identity.pid}:${identity.startToken}`, verdict);
  }

  public identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: 'test' });
  }

  public check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    return Promise.resolve(this.table.get(`${identity.pid}:${identity.startToken}`) ?? 'dead');
  }
}

const META: HostLockMetadata = {
  build_id: 'build-1',
  yantra_version: '0.0.1',
  channel_version: 1,
};
const FIRST: ProcessIdentity = { pid: 1001, startToken: 'first' };
const SECOND: ProcessIdentity = { pid: 1002, startToken: 'second' };

let home: string;
let previousHome: string | undefined;
let probe: TableProbe;

function makeLock(): FileHostLock {
  return new FileHostLock({ liveness: probe, now: () => new Date('2026-11-11T10:00:00.000Z') });
}

function readRecord(): HostLockRecord {
  return HostLockRecord.parse(JSON.parse(readFileSync(uiHostLockPath(), 'utf8')));
}

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-host-lock-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  probe = new TableProbe();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('ui paths', () => {
  it('places every app host file under <data-dir>/ui', () => {
    const root = join(home, 'data', 'ui');
    expect(uiRoot()).toBe(root);
    expect(uiHostLockPath()).toBe(join(root, 'host.lock'));
    expect(slotsLockPath()).toBe(join(root, 'slots.lock'));
    expect(invocationsRoot()).toBe(join(root, 'invocations'));
    expect(invocationPath('01JD2X7Q8R9S0T1V2W3X4Y5Z6A')).toBe(
      join(root, 'invocations', '01JD2X7Q8R9S0T1V2W3X4Y5Z6A.json'),
    );
    expect(invocationResultPath('01JD2X7Q8R9S0T1V2W3X4Y5Z6A')).toBe(
      join(root, 'invocations', '01JD2X7Q8R9S0T1V2W3X4Y5Z6A.result.json'),
    );
    expect(hostLogPath()).toBe(join(root, 'host.log'));
    expect(uiChromeProfilePath()).toBe(join(root, 'chrome-profile'));
    expect(workerLaunchRoot()).toBe(join(root, 'launch'));
  });

  it.each(['../../escape-me-now', 'short', `${'a'.repeat(20)}/x`, ''])(
    'refuses an invocation ID that could escape the directory (%s)',
    (id) => {
      expect(() => invocationPath(id)).toThrow(/Invalid invocation ID/);
      expect(() => invocationResultPath(id)).toThrow(/Invalid invocation ID/);
    },
  );
});

describe('FileHostLock.acquire', () => {
  it('writes a starting record with a 256-bit control token', async () => {
    // Arrange
    const lock = makeLock();

    // Act
    const record = await lock.acquire(FIRST, META);

    // Assert
    expect(record).toMatchObject({
      state: 'starting',
      pid: FIRST.pid,
      start_token: FIRST.startToken,
      port: null,
      control_socket: null,
      build_id: 'build-1',
      started_at: '2026-11-11T10:00:00.000Z',
      env_captured_at: '2026-11-11T10:00:00.000Z',
    });
    expect(Buffer.from(record.control_token, 'base64url')).toHaveLength(32);
    expect(readRecord()).toEqual(record);
  });

  it('issues a different control token on each acquisition', async () => {
    const first = await makeLock().acquire(FIRST, META);
    const second = await makeLock().acquire(SECOND, META); // FIRST reads as dead
    expect(second.control_token).not.toBe(first.control_token);
  });

  it('throws HostLockHeldError carrying the record when the holder is alive', async () => {
    // Arrange
    const held = await makeLock().acquire(FIRST, META);
    probe.set(FIRST, 'alive');

    // Act
    const error = await makeLock()
      .acquire(SECOND, META)
      .catch((caught: unknown) => caught);

    // Assert
    expect(error).toBeInstanceOf(HostLockHeldError);
    expect((error as HostLockHeldError).record).toEqual(held);
    expect((error as HostLockHeldError).uncertain).toBe(false);
    expect(readRecord().pid).toBe(FIRST.pid);
  });

  it('replaces a dead holder', async () => {
    await makeLock().acquire(FIRST, META);
    probe.set(FIRST, 'dead');

    const record = await makeLock().acquire(SECOND, META);

    expect(record.pid).toBe(SECOND.pid);
    expect(readRecord().pid).toBe(SECOND.pid);
  });

  it('treats a reused PID (same PID, different start token) as dead', async () => {
    // Arrange: the recorded holder is FIRST; a different process now has its PID.
    await makeLock().acquire(FIRST, META);
    probe.set({ pid: FIRST.pid, startToken: 'someone-else' }, 'alive');

    // Act
    const record = await makeLock().acquire(SECOND, META);

    // Assert
    expect(record.pid).toBe(SECOND.pid);
  });

  it('never reclaims an unknown holder', async () => {
    await makeLock().acquire(FIRST, META);
    probe.set(FIRST, 'unknown');

    const error = await makeLock()
      .acquire(SECOND, META)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostLockHeldError);
    expect((error as HostLockHeldError).uncertain).toBe(true);
    expect((error as HostLockHeldError).remediation).toContain(uiHostLockPath());
    expect(readRecord().pid).toBe(FIRST.pid);
  });

  it('never reclaims an unreadable record', async () => {
    await makeLock().acquire(FIRST, META);
    writeFileSync(uiHostLockPath(), '{ not json');

    const error = await makeLock()
      .acquire(SECOND, META)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HostLockHeldError);
    expect((error as HostLockHeldError).record).toBeNull();
    expect(readFileSync(uiHostLockPath(), 'utf8')).toBe('{ not json');
  });

  it('lets exactly one of several concurrent acquirers win against a live winner', async () => {
    // Arrange: every acquirer reads as alive once it has written its record.
    const identities = Array.from({ length: 6 }, (_, i) => ({ pid: 2000 + i, startToken: 't' }));
    for (const identity of identities) probe.set(identity, 'alive');

    // Act
    const outcomes = await Promise.allSettled(
      identities.map((identity) => makeLock().acquire(identity, META)),
    );

    // Assert
    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
    for (const loser of losers) expect(loser.reason).toBeInstanceOf(HostLockHeldError);
    expect(readRecord().pid).toBe((winners[0] as PromiseFulfilledResult<HostLockRecord>).value.pid);
  });
});

describe('FileHostLock.markReady', () => {
  it('rewrites the record as ready with its port and socket', async () => {
    const lock = makeLock();
    const started = await lock.acquire(FIRST, META);

    const ready = await lock.markReady({ port: 51_234, control_socket: 'pipe-name' });

    expect(ready).toEqual({
      ...started,
      state: 'ready',
      port: 51_234,
      control_socket: 'pipe-name',
    });
    expect(readRecord()).toEqual(ready);
  });

  it('can replace the build ID it serves', async () => {
    const lock = makeLock();
    await lock.acquire(FIRST, META);
    const ready = await lock.markReady({ port: 1, control_socket: 's', build_id: 'build-2' });
    expect(ready.build_id).toBe('build-2');
  });

  it('never exposes a partial record: a crash between temp write and rename leaves the old record', async () => {
    // Arrange: a starting record, then a crashed writer's half-written temp file beside it.
    const lock = makeLock();
    const started = await lock.acquire(FIRST, META);
    writeFileSync(uniqueTempPath(uiHostLockPath()), '{"schema_version":1,"state":"rea');

    // Act
    const seen = await makeLock().probe();

    // Assert
    expect(seen.record).toEqual(started);
  });

  it('publishes through a temp file and leaves none behind', async () => {
    const lock = makeLock();
    await lock.acquire(FIRST, META);
    await lock.markReady({ port: 2, control_socket: 's' });
    const leftovers = readdirSync(uiRoot()).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('refuses to mark ready once another process owns the lock', async () => {
    const mine = makeLock();
    await mine.acquire(FIRST, META);
    await makeLock().acquire(SECOND, META); // FIRST reads as dead and is replaced

    await expect(mine.markReady({ port: 3, control_socket: 's' })).rejects.toThrow(
      /no longer owns/,
    );
    expect(readRecord().pid).toBe(SECOND.pid);
  });
});

describe('FileHostLock.probe', () => {
  it('reports absent when there is no lock', async () => {
    expect(await makeLock().probe()).toEqual({ verdict: 'absent', record: null });
  });

  it('reports the record with the holder verdict', async () => {
    const record = await makeLock().acquire(FIRST, META);
    probe.set(FIRST, 'alive');
    expect(await makeLock().probe()).toEqual({ verdict: 'alive', record });
  });

  it('reports a schema-invalid record as corrupt', async () => {
    await makeLock().acquire(FIRST, META);
    writeFileSync(uiHostLockPath(), JSON.stringify({ pid: 1 }));
    expect(await makeLock().probe()).toEqual({ verdict: 'corrupt', record: null });
  });
});

describe('FileHostLock.release', () => {
  it('removes the record it owns', async () => {
    const lock = makeLock();
    await lock.acquire(FIRST, META);
    expect(await lock.release()).toBe(true);
    expect(await makeLock().probe()).toEqual({ verdict: 'absent', record: null });
  });

  it('leaves the file when called by a non-owner', async () => {
    await makeLock().acquire(FIRST, META);
    const stranger = makeLock();
    expect(await stranger.release()).toBe(false);
    expect(readRecord().pid).toBe(FIRST.pid);
  });

  it('leaves a successor host’s record alone', async () => {
    const mine = makeLock();
    await mine.acquire(FIRST, META);
    await makeLock().acquire(SECOND, META);
    expect(await mine.release()).toBe(false);
    expect(readRecord().pid).toBe(SECOND.pid);
  });

  it('is idempotent', async () => {
    const lock = makeLock();
    await lock.acquire(FIRST, META);
    await lock.release();
    expect(await lock.release()).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('POSIX file modes', () => {
  it('writes the lock 0600 inside a 0700 directory', async () => {
    await makeLock().acquire(FIRST, META);
    expect(statSync(uiHostLockPath()).mode & 0o777).toBe(0o600);
    expect(statSync(uiRoot()).mode & 0o777).toBe(0o700);
  });
});
