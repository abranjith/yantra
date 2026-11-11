// @no-llm
/**
 * The run lease store (FEAT-064 TASK-004, amended by spike S2 RC2 and RC4).
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { RUN_TOKEN_PATTERN, RunLease } from '@yantra/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_UNIX_SOCKET_PATH_BYTES,
  RUN_PIPE_PREFIX,
  socketsRoot,
  uiHostLockPath,
  workerLaunchRoot,
} from '../../src/browser/paths.js';
import {
  NodeProcessLivenessProbe,
  UNKNOWN_START_TOKEN,
  checkIdentities,
  currentProcessIdentity,
} from '../../src/browser/process-identity.js';
import { resetPathCache } from '../../src/config/resolved-paths.js';
import { ResourceBusyError } from '../../src/locks/resource-lock.js';
import { FileBrowserOwnershipRecorder } from '../../src/run-ownership/browser-ownership-recorder.js';
import { OWNED_BROWSERS_FILENAME, RUN_LEASE_FILENAME } from '../../src/run-ownership/constants.js';
import { RunLeaseHeldError } from '../../src/run-ownership/errors.js';
import {
  claimLease,
  generateRunToken,
  ownerVerdict,
  readLease,
  readOwnedBrowsers,
  releaseLease,
} from '../../src/run-ownership/lease-store.js';

import { OWNER, TableProbe, claimInit, cleanupDirs, makeTempDir } from './support.js';

afterEach(cleanupDirs);

const FLUSHED = { evidenceFlushed: true } as const;

describe('@no-llm claimLease', () => {
  it('publishes a complete lease naming this owner, with the given socket and epoch', async () => {
    const runDir = makeTempDir();
    const lease = await claimLease(runDir, claimInit({ logSeqAtClaim: 12 }), {
      identity: OWNER,
      clock: () => new Date('2026-11-09T12:00:00.000Z'),
    });
    const onDisk = RunLease.parse(
      JSON.parse(readFileSync(join(runDir, RUN_LEASE_FILENAME), 'utf8')),
    );
    expect(onDisk).toEqual(lease);
    expect(lease).toMatchObject({
      owner: { pid: OWNER.pid, start_token: OWNER.startToken },
      origin: 'terminal',
      execution_class: 'run',
      log_seq_at_claim: 12,
      channel_version: 1,
      claimed_at: '2026-11-09T12:00:00.000Z',
    });
    expect(lease.run_token).toMatch(RUN_TOKEN_PATTERN);
  });

  it('defaults the owner to this process identity', async () => {
    const lease = await claimLease(makeTempDir(), claimInit());
    const own = await currentProcessIdentity();
    expect(lease.owner).toEqual({ pid: process.pid, start_token: own.startToken });
  });

  it('lets exactly one of two concurrent claims win; the loser names the holder', async () => {
    const runDir = makeTempDir();
    const probe = new TableProbe({ [`${OWNER.pid}:${OWNER.startToken}`]: 'alive' });
    const results = await Promise.allSettled([
      claimLease(runDir, claimInit(), { identity: OWNER, probe }),
      claimLease(runDir, claimInit(), { identity: OWNER, probe }),
    ]);
    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const error = (lost[0] as PromiseRejectedResult).reason as RunLeaseHeldError;
    expect(error).toBeInstanceOf(RunLeaseHeldError);
    expect(error).toBeInstanceOf(ResourceBusyError);
    expect(error.verdict).toBe('alive');
    expect(error.message).toContain(`pid ${OWNER.pid}`);
    const winner = (won[0] as PromiseFulfilledResult<RunLease>).value;
    expect(error.message).not.toContain(winner.run_token);
    expect(error.message).not.toContain(winner.socket.address);
  });

  it('leaves no temp file behind, whether the claim wins or loses', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    await claimLease(runDir, claimInit(), { identity: OWNER }).catch(() => undefined);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(runDir)).toEqual([RUN_LEASE_FILENAME]);
  });

  it('never lets a polling reader observe a partial or empty lease', async () => {
    const runDir = makeTempDir();
    let polling = true;
    const seen = { lease: 0, absent: 0, corrupt: 0 };
    const reader = (async () => {
      while (polling) {
        seen[(await readLease(runDir)).kind] += 1;
      }
    })();
    for (let round = 0; round < 50; round += 1) {
      await claimLease(runDir, claimInit(), { identity: OWNER });
      await releaseLease(runDir, FLUSHED);
    }
    polling = false;
    await reader;
    expect(seen.corrupt).toBe(0);
    expect(seen.lease + seen.absent).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('writes the lease with mode 0600', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    expect(statSync(join(runDir, RUN_LEASE_FILENAME)).mode & 0o777).toBe(0o600);
  });
  // Windows: the lease inherits the user-profile ACL (plan §7); there is no mode to assert.
});

describe('@no-llm generateRunToken', () => {
  it('is 43 base64url characters and unique across 1,000 tokens', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 1_000; index += 1) {
      const token = generateRunToken();
      expect(token).toMatch(RUN_TOKEN_PATTERN);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1_000);
  });
});

describe('@no-llm readLease', () => {
  it('reads a missing lease as absent, never throwing', async () => {
    expect(await readLease(makeTempDir())).toEqual({ kind: 'absent' });
    expect(await readLease(join(makeTempDir(), 'missing'))).toEqual({ kind: 'absent' });
  });

  it.each([
    ['empty', ''],
    ['truncated', '{"schema_version":1,"run_id":'],
    ['wrong shape', '{"schema_version":1}'],
  ])('reports a %s lease as corrupt', async (_label, content) => {
    const runDir = makeTempDir();
    writeFileSync(join(runDir, RUN_LEASE_FILENAME), content);
    expect(await readLease(runDir)).toEqual({ kind: 'corrupt' });
  });
});

describe('@no-llm releaseLease', () => {
  it('removes the lease and is a no-op the second time', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    expect(await releaseLease(runDir, FLUSHED)).toEqual({ released: true, retainedBrowsers: 0 });
    expect(await releaseLease(runDir, FLUSHED)).toEqual({ released: true, retainedBrowsers: 0 });
    expect(await readLease(runDir)).toEqual({ kind: 'absent' });
  });

  it('removes owned-browsers.jsonl once every browser is proved exited', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    const recorder = new FileBrowserOwnershipRecorder(runDir);
    await recorder.recordSpawned({ pid: 7, startToken: 'linux:1' });
    await recorder.recordExited({ pid: 7, startToken: 'linux:1' });
    await releaseLease(runDir, FLUSHED);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(runDir, OWNED_BROWSERS_FILENAME))).toBe(false);
  });

  it('keeps the lease as a possible-orphan record while a browser exit is unproved', async () => {
    const runDir = makeTempDir();
    await claimLease(runDir, claimInit(), { identity: OWNER });
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned({ pid: 7, startToken: 'x' });
    expect(await releaseLease(runDir, FLUSHED)).toEqual({ released: false, retainedBrowsers: 1 });
    expect((await readLease(runDir)).kind).toBe('lease');
  });
});

describe('@no-llm readOwnedBrowsers', () => {
  it('folds spawned and exited lines by identity, in first-spawn order', async () => {
    const runDir = makeTempDir();
    const recorder = new FileBrowserOwnershipRecorder(runDir);
    await recorder.recordSpawned({ pid: 1, startToken: 'a' });
    await recorder.recordSpawned({ pid: 2, startToken: UNKNOWN_START_TOKEN });
    await recorder.recordSpawned({ pid: 3, startToken: 'c' });
    await recorder.recordExited({ pid: 1, startToken: 'a' });
    // A reused PID with another creation token is a different browser.
    await recorder.recordExited({ pid: 3, startToken: 'other' });
    expect(await readOwnedBrowsers(runDir)).toEqual([
      { pid: 2, startToken: UNKNOWN_START_TOKEN },
      { pid: 3, startToken: 'c' },
    ]);
  });

  it('ignores a trailing partial line and lines that do not parse', async () => {
    const runDir = makeTempDir();
    await new FileBrowserOwnershipRecorder(runDir).recordSpawned({ pid: 1, startToken: 'a' });
    const path = join(runDir, OWNED_BROWSERS_FILENAME);
    appendFileSync(path, 'not json\n{"schema_version":1,"op":"spawned"}\n{"schema_ver');
    expect(await readOwnedBrowsers(runDir)).toEqual([{ pid: 1, startToken: 'a' }]);
  });

  it('reads a missing file as no browsers', async () => {
    expect(await readOwnedBrowsers(makeTempDir())).toEqual([]);
  });
});

describe('@no-llm FileBrowserOwnershipRecorder', () => {
  it('keeps call order for appends that are not awaited one by one', async () => {
    const runDir = makeTempDir();
    const recorder = new FileBrowserOwnershipRecorder(
      runDir,
      () => new Date('2026-11-09T12:00:00.000Z'),
    );
    await Promise.all([
      recorder.recordSpawned({ pid: 1, startToken: 'a' }),
      recorder.recordExited({ pid: 1, startToken: 'a' }),
      recorder.recordSpawned({ pid: 2, startToken: 'b' }),
    ]);
    const lines = readFileSync(join(runDir, OWNED_BROWSERS_FILENAME), 'utf8').trim().split('\n');
    expect(lines.map((line) => (JSON.parse(line) as { op: string; pid: number }).op)).toEqual([
      'spawned',
      'exited',
      'spawned',
    ]);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      schema_version: 1,
      op: 'spawned',
      pid: 1,
      start_token: 'a',
      at: '2026-11-09T12:00:00.000Z',
    });
  });
});

describe('@no-llm ownerVerdict', () => {
  it.each(['alive', 'dead', 'unknown'] as const)('maps a probe %s verdict 1:1', async (verdict) => {
    const runDir = makeTempDir();
    const lease = await claimLease(runDir, claimInit(), { identity: OWNER });
    const probe = new TableProbe({}, verdict);
    expect(await ownerVerdict(lease, probe)).toBe(verdict);
    expect(probe.checked).toEqual([OWNER]);
  });

  it('answers unknown, never dead, for a live owner recorded with an unknown token', async () => {
    const lease = await claimLease(makeTempDir(), claimInit(), {
      identity: { pid: process.pid, startToken: UNKNOWN_START_TOKEN },
    });
    expect(await ownerVerdict(lease, new NodeProcessLivenessProbe())).toBe('unknown');
  });
});

describe('@no-llm NodeProcessLivenessProbe (RC4)', () => {
  const GONE = 0x3ffffff0; // far above any PID the OS hands out

  it('answers dead for a missing PID without a platform query', async () => {
    const started = Date.now();
    expect(await new NodeProcessLivenessProbe().check({ pid: GONE, startToken: 'x' })).toBe('dead');
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('checks many identities in input order with one batched query', async () => {
    const own = await currentProcessIdentity();
    const verdicts = await checkIdentities(new NodeProcessLivenessProbe(), [
      { pid: GONE, startToken: 'x' },
      own,
      { pid: process.pid, startToken: 'reused-pid' },
      { pid: process.pid, startToken: UNKNOWN_START_TOKEN },
    ]);
    expect(verdicts).toEqual([
      'dead',
      own.startToken === UNKNOWN_START_TOKEN ? 'unknown' : 'alive',
      own.startToken === UNKNOWN_START_TOKEN ? 'unknown' : 'dead',
      'unknown',
    ]);
  }, 30_000);

  it('falls back to one check per identity for a probe without checkMany', async () => {
    const probe = new TableProbe({ '1:a': 'alive' });
    const single = { identify: probe.identify.bind(probe), check: probe.check.bind(probe) };
    expect(
      await checkIdentities(single, [
        { pid: 1, startToken: 'a' },
        { pid: 2, startToken: 'b' },
      ]),
    ).toEqual(['alive', 'dead']);
    expect(await checkIdentities(single, [])).toEqual([]);
  });
});

describe('@no-llm run ownership paths', () => {
  const saved = process.env.YANTRA_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = saved;
    resetPathCache();
  });

  it('uses the named-pipe prefix on Windows', () => {
    expect(socketsRoot('win32')).toBe(RUN_PIPE_PREFIX);
    expect(RUN_PIPE_PREFIX).toBe('\\\\.\\pipe\\yantra-');
  });

  it('uses <home>/run on POSIX when a socket path fits', () => {
    process.env.YANTRA_HOME = '/home/u/.yantra';
    expect(socketsRoot('linux')).toBe(join('/home/u/.yantra', 'run'));
  });

  it('falls back to a per-user temp directory when the home path is too long for a socket', () => {
    process.env.YANTRA_HOME = `/home/${'u'.repeat(MAX_UNIX_SOCKET_PATH_BYTES)}/.yantra`;
    const root = socketsRoot('linux');
    expect(root).not.toContain('uuuuuuuu');
    expect(root).toMatch(/yantra-\d+$/);
  });

  it('puts the launch directory and host lock under <data>/ui', () => {
    process.env.YANTRA_HOME = makeTempDir();
    resetPathCache();
    expect(workerLaunchRoot()).toBe(join(process.env.YANTRA_HOME, 'data', 'ui', 'launch'));
    expect(uiHostLockPath()).toBe(join(process.env.YANTRA_HOME, 'data', 'ui', 'host.lock'));
  });
});
