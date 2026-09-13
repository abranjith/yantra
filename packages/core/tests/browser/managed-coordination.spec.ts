import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedCoordinationError } from '../../src/browser/errors.js';
import type {
  LivenessVerdict,
  ManagedReadyRecord,
  ProcessIdentity,
  ProcessLivenessProbe,
} from '../../src/browser/installation-types.js';
import {
  type CandidateProbePermit,
  LocalManagedCoordinator,
  assertCandidateProbePermit,
  issueCandidateProbePermit,
  revokeCandidateProbePermit,
  trackCandidateProbeProcess,
  type OwnedManagedUseReservation,
} from '../../src/browser/managed-coordination.js';
import {
  LocalManagedStateReader,
  ManagedReadyRecordSchema,
} from '../../src/browser/managed-state.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'coordination-owner.mjs');
const BUILD_ID = '152.0.7977.75';

function readyRecord(overrides: Record<string, unknown> = {}): ManagedReadyRecord {
  return ManagedReadyRecordSchema.parse({
    schemaVersion: 1,
    installationId: 'abc123',
    browser: 'chrome',
    platform: process.platform === 'win32' ? 'win64' : 'linux',
    buildId: BUILD_ID,
    cacheRootRelative: 'installation-abc123',
    executableRelative: `chrome/linux-${BUILD_ID}/chrome-linux64/chrome`,
    verifiedAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  });
}

/** Scriptable liveness so every verdict — including `unknown` — is reachable. */
class ScriptedLiveness implements ProcessLivenessProbe {
  readonly verdicts = new Map<number, LivenessVerdict>();

  identify(pid: number): Promise<ProcessIdentity | null> {
    return Promise.resolve({ pid, startToken: `token-${pid}` });
  }

  check(identity: ProcessIdentity): Promise<LivenessVerdict> {
    return Promise.resolve(this.verdicts.get(identity.pid) ?? 'alive');
  }
}

describe('@no-llm LocalManagedCoordinator', () => {
  let root: string;
  let liveness: ScriptedLiveness;
  let self: ProcessIdentity;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-coord-'));
    liveness = new ScriptedLiveness();
    self = { pid: 4242, startToken: 'token-4242' };
    liveness.verdicts.set(4242, 'alive');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeCoordinator(ready: ManagedReadyRecord | null = readyRecord(), overrides = {}) {
    return new LocalManagedCoordinator({
      managedState: {
        readReady: () =>
          Promise.resolve(
            ready === null
              ? { status: 'absent' as const }
              : { status: 'ready' as const, record: ready },
          ),
        readInventory: () =>
          Promise.resolve({
            ready:
              ready === null
                ? { status: 'absent' as const }
                : { status: 'ready' as const, record: ready },
            orphans: [],
          }),
      },
      liveness,
      coordinationRoot: () => join(root, 'coordination'),
      operationPath: () => join(root, 'operation.json'),
      selfIdentity: () => Promise.resolve(self),
      clock: () => new Date('2026-09-13T00:00:00.000Z'),
      ...overrides,
    });
  }

  it('reserves use of the installation the caller resolved', async () => {
    const coordinator = makeCoordinator();

    const reservation = await coordinator.reserveUse(readyRecord());

    expect(reservation.installationId).toBe('abc123');
    await expect(coordinator.hasActiveUse()).resolves.toBe(true);
  });

  it('refuses a reservation when the ready record changed since resolution', async () => {
    const coordinator = makeCoordinator(readyRecord({ buildId: '153.0.8010.36' }));

    await expect(coordinator.reserveUse(readyRecord())).rejects.toMatchObject({
      name: 'ManagedCoordinationError',
      context: { reason: 'ready-changed' },
    });
  });

  it('refuses a reservation when the installation is no longer ready at all', async () => {
    const coordinator = makeCoordinator(null);

    await expect(coordinator.reserveUse(readyRecord())).rejects.toMatchObject({
      context: { reason: 'ready-changed' },
    });
  });

  it('refuses a managed launch while a mutation is live', async () => {
    const coordinator = makeCoordinator();
    await coordinator.claimMutation('op-1', 'installation-candidate');

    await expect(coordinator.reserveUse(readyRecord())).rejects.toMatchObject({
      context: { reason: 'operation-in-progress' },
    });
  });

  it('refuses a mutation claim while a reservation is live', async () => {
    const coordinator = makeCoordinator();
    await coordinator.reserveUse(readyRecord());

    await expect(coordinator.claimMutation('op-1', 'installation-candidate')).rejects.toMatchObject(
      { context: { reason: 'active-use' } },
    );
  });

  it('refuses a second mutation claim while the first owner is live', async () => {
    const coordinator = makeCoordinator();
    await coordinator.claimMutation('op-1', 'installation-a');

    await expect(coordinator.claimMutation('op-2', 'installation-b')).rejects.toMatchObject({
      context: { reason: 'operation-in-progress' },
    });
  });

  it('lets a new claim through once the previous owner is provably dead', async () => {
    const coordinator = makeCoordinator();
    await coordinator.claimMutation('op-1', 'installation-a');
    liveness.verdicts.set(4242, 'dead');

    const lease = await coordinator.claimMutation('op-2', 'installation-b');

    expect(lease.operationId).toBe('op-2');
  });

  it('does not let a dead mutation owner block managed use', async () => {
    const coordinator = makeCoordinator();
    await coordinator.claimMutation('op-dead', 'installation-candidate');
    liveness.verdicts.set(4242, 'dead');

    // A record whose owner is provably dead is reclaimable, so an ordinary
    // managed launch is not refused by it.
    const reservation = await coordinator.reserveUse(readyRecord());

    expect(reservation.installationId).toBe('abc123');
    // Nothing was reconciled or deleted along the way — that belongs to the
    // next explicit install/update, not to a launch.
    await expect(readFile(join(root, 'operation.json'), 'utf8')).resolves.toContain('op-dead');
  });

  it('reports a dead owner’s candidate as an orphan with no live owner', async () => {
    const coordinator = makeCoordinator();
    await coordinator.claimMutation('op-dead', 'installation-candidate');
    await mkdir(join(root, 'installation-candidate'), { recursive: true });
    const stateReader = new LocalManagedStateReader({
      root: () => root,
      readyPath: () => join(root, 'ready.json'),
      liveMutationCandidate: coordinator.liveMutationCandidate,
    });

    const whileLive = await stateReader.readInventory();
    expect(whileLive.orphans).toEqual([
      { cacheRootRelative: 'installation-candidate', bytes: 0, hasLiveOwner: true },
    ]);

    liveness.verdicts.set(4242, 'dead');
    const whenDead = await stateReader.readInventory();

    expect(await coordinator.liveMutationCandidate()).toBeNull();
    expect(whenDead.orphans).toEqual([
      { cacheRootRelative: 'installation-candidate', bytes: 0, hasLiveOwner: false },
    ]);
  });

  it('rejects a candidate root that is not exactly one installation segment', async () => {
    const coordinator = makeCoordinator();

    await expect(coordinator.claimMutation('op-1', '../escape')).rejects.toMatchObject({
      context: { reason: 'invalid-permit' },
    });
    await expect(coordinator.claimMutation('op-1', 'installation-a/nested')).rejects.toThrow(
      ManagedCoordinationError,
    );
  });

  describe('reservation lifecycle', () => {
    it('keeps the reservation while the browser child is still alive', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());
      await reservation.attachChild({ pid: 9001, startToken: 'token-9001' });
      liveness.verdicts.set(9001, 'alive');

      await expect(reservation.releaseAfterExit()).rejects.toMatchObject({
        context: { reason: 'uncertain-owner' },
      });
      await expect(coordinator.hasActiveUse()).resolves.toBe(true);
    });

    it('keeps the reservation when child liveness is uncertain', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());
      await reservation.attachChild({ pid: 9002, startToken: 'token-9002' });
      liveness.verdicts.set(9002, 'unknown');

      await expect(reservation.releaseAfterExit()).rejects.toMatchObject({
        context: { reason: 'uncertain-owner' },
      });
      await expect(coordinator.hasActiveUse()).resolves.toBe(true);
    });

    it('releases only after the child is verified dead', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());
      await reservation.attachChild({ pid: 9003, startToken: 'token-9003' });
      liveness.verdicts.set(9003, 'dead');

      await reservation.releaseAfterExit();

      await expect(coordinator.hasActiveUse()).resolves.toBe(false);
    });

    it('is idempotent across repeated releases', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());
      await reservation.attachChild({ pid: 9004, startToken: 'token-9004' });
      liveness.verdicts.set(9004, 'dead');

      await reservation.releaseAfterExit();
      await expect(reservation.releaseAfterExit()).resolves.toBeUndefined();
      await expect(reservation.releaseAfterExit()).resolves.toBeUndefined();
    });

    it('stays busy when a live child outlives a dead parent', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());
      await reservation.attachChild({ pid: 9005, startToken: 'token-9005' });
      liveness.verdicts.set(4242, 'dead');
      liveness.verdicts.set(9005, 'alive');

      await expect(coordinator.hasActiveUse()).resolves.toBe(true);
    });

    it('stays busy for a starting reservation whose child state cannot be proved', async () => {
      const coordinator = makeCoordinator();
      await coordinator.reserveUse(readyRecord());
      liveness.verdicts.set(4242, 'dead');

      await expect(coordinator.hasActiveUse()).resolves.toBe(true);
      await expect(
        coordinator.claimMutation('op-1', 'installation-candidate'),
      ).rejects.toMatchObject({ context: { reason: 'active-use' } });
    });

    it('refuses to release a starting reservation with no proven outcome', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());

      await expect(reservation.releaseAfterExit()).rejects.toMatchObject({
        context: { reason: 'uncertain-owner' },
      });
    });

    it('releases a reservation whose browser was proven never to spawn', async () => {
      const coordinator = makeCoordinator();
      const reservation = await coordinator.reserveUse(readyRecord());

      await reservation.markNeverSpawned();

      await expect(coordinator.hasActiveUse()).resolves.toBe(false);
    });

    it('keeps the reservation when attaching the child fails', async () => {
      const coordinator = makeCoordinator();
      const reservation: OwnedManagedUseReservation = await coordinator.reserveUse(readyRecord());
      const failing = vi
        .spyOn(coordinator, 'writeReservation')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(
        reservation.attachChild({ pid: 9006, startToken: 'token-9006' }),
      ).rejects.toThrow(/disk full/);
      failing.mockRestore();

      await expect(coordinator.hasActiveUse()).resolves.toBe(true);
    });

    it('ignores a corrupt reservation file rather than treating it as a live run', async () => {
      const coordinator = makeCoordinator();
      const dir = join(root, 'coordination', 'reservations');
      await coordinator.reserveUse(readyRecord());
      const [name] = await readdir(dir);
      await writeFile(join(dir, name!), '{not json', 'utf8');

      await expect(coordinator.hasActiveUse()).resolves.toBe(false);
    });
  });

  describe('mutation lease', () => {
    it('confirms ownership while the claim is still ours', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');

      await expect(lease.assertOwned()).resolves.toBeUndefined();
    });

    it('reports lost ownership when another operation took the claim', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      liveness.verdicts.set(4242, 'dead');
      await coordinator.claimMutation('op-2', 'installation-b');

      await expect(lease.assertOwned()).rejects.toMatchObject({
        context: { reason: 'lost-ownership' },
      });
    });

    it('reports lost ownership after release', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      await lease.release();

      await expect(lease.assertOwned()).rejects.toMatchObject({
        context: { reason: 'lost-ownership' },
      });
    });

    it('release is idempotent and never clears another operation’s claim', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      await lease.release();
      liveness.verdicts.set(4242, 'alive');
      await coordinator.claimMutation('op-2', 'installation-b');

      await lease.release();

      await expect(readFile(join(root, 'operation.json'), 'utf8')).resolves.toContain('op-2');
    });
  });

  describe('candidate probe permits', () => {
    it('authorizes exactly the lease’s own candidate and executable', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });

      await expect(
        assertCandidateProbePermit(permit, {
          candidateRootRelative: 'installation-a',
          executablePath: '/candidate/chrome',
        }),
      ).resolves.toBeUndefined();
    });

    it('refuses to mint a permit for a candidate the lease does not own', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');

      expect(() =>
        issueCandidateProbePermit(lease, {
          candidateRootRelative: 'installation-b',
          executablePath: '/candidate/chrome',
        }),
      ).toThrow(ManagedCoordinationError);
    });

    it('rejects a permit used against the wrong candidate root or executable', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });

      await expect(
        assertCandidateProbePermit(permit, {
          candidateRootRelative: 'installation-b',
          executablePath: '/candidate/chrome',
        }),
      ).rejects.toMatchObject({ context: { reason: 'invalid-permit' } });
      await expect(
        assertCandidateProbePermit(permit, {
          candidateRootRelative: 'installation-a',
          executablePath: '/elsewhere/chrome',
        }),
      ).rejects.toMatchObject({ context: { reason: 'invalid-permit' } });
    });

    it('rejects a revoked permit', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });
      revokeCandidateProbePermit(permit);

      await expect(
        assertCandidateProbePermit(permit, {
          candidateRootRelative: 'installation-a',
          executablePath: '/candidate/chrome',
        }),
      ).rejects.toMatchObject({ context: { reason: 'invalid-permit' } });
    });

    it('rejects a forged permit even when the type system is bypassed', async () => {
      // The runtime registry is the half that still holds when a cast defeats
      // the nominal brand — which is the only way this object can exist.
      const forged = {
        operationId: 'op-1',
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      } as unknown as CandidateProbePermit;

      await expect(
        assertCandidateProbePermit(forged, {
          candidateRootRelative: 'installation-a',
          executablePath: '/candidate/chrome',
        }),
      ).rejects.toMatchObject({ context: { reason: 'invalid-permit' } });
    });

    it('rejects a permit once its lease has lost ownership', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });
      liveness.verdicts.set(4242, 'dead');
      await coordinator.claimMutation('op-2', 'installation-b');

      await expect(
        assertCandidateProbePermit(permit, {
          candidateRootRelative: 'installation-a',
          executablePath: '/candidate/chrome',
        }),
      ).rejects.toMatchObject({ context: { reason: 'lost-ownership' } });
    });

    it('makes lease release await every tracked probe process exit', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      const permit = issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });
      let exitProbe!: () => void;
      const probeExited = new Promise<void>((r) => {
        exitProbe = r;
      });
      trackCandidateProbeProcess(permit, probeExited);

      let releaseSettled = false;
      const releasing = lease.release().then(() => {
        releaseSettled = true;
      });
      await Promise.resolve();
      expect(releaseSettled).toBe(false);

      exitProbe();
      await releasing;
      expect(releaseSettled).toBe(true);
    });

    it('cannot be used for an ordinary launch: no permit means no bypass', async () => {
      const coordinator = makeCoordinator();
      const lease = await coordinator.claimMutation('op-1', 'installation-a');
      issueCandidateProbePermit(lease, {
        candidateRootRelative: 'installation-a',
        executablePath: '/candidate/chrome',
      });

      // Holding a permit does not make an ordinary managed reservation legal
      // while the mutation is live — that exclusion is unchanged.
      await expect(coordinator.reserveUse(readyRecord())).rejects.toMatchObject({
        context: { reason: 'operation-in-progress' },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Real cross-process ownership
// ---------------------------------------------------------------------------

interface OwnerHandle {
  readonly child: ChildProcessWithoutNullStreams;
  readonly firstEvent: Promise<Record<string, unknown>>;
  release(): Promise<void>;
  kill(): Promise<void>;
}

describe('@no-llm managed coordination across real processes', () => {
  let root: string;
  let readyPath: string;
  const owners: OwnerHandle[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-coord-proc-'));
    readyPath = join(root, 'ready.json');
    await writeFile(readyPath, JSON.stringify(readyRecord()), 'utf8');
  });

  afterEach(async () => {
    for (const owner of owners.splice(0)) await owner.kill();
    await rm(root, { recursive: true, force: true });
  });

  function startOwner(mode: 'use' | 'mutation', extra: readonly string[] = []): OwnerHandle {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        FIXTURE,
        '--mode',
        mode,
        '--root',
        root,
        '--ready',
        readyPath,
        '--coordination',
        join(root, 'coordination'),
        '--operation',
        join(root, 'operation.json'),
        '--deadline',
        '20000',
        ...extra,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    ) as ChildProcessWithoutNullStreams;

    const firstEvent = new Promise<Record<string, unknown>>((resolveEvent, rejectEvent) => {
      let buffer = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        try {
          resolveEvent(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
        } catch (error) {
          rejectEvent(error as Error);
        }
      });
      child.once('exit', (code) => {
        if (buffer.trim().length === 0)
          rejectEvent(new Error(`owner exited early (${code}): ${stderr}`));
      });
    });

    const exited = new Promise<void>((r) => child.once('exit', () => r()));
    const handle: OwnerHandle = {
      child,
      firstEvent,
      release: async () => {
        child.stdin.write('release\n');
        await exited;
      },
      kill: async () => {
        if (child.exitCode === null) child.kill('SIGKILL');
        await exited;
      },
    };
    owners.push(handle);
    return handle;
  }

  it('refuses a mutation claim while another real process holds a use reservation', async () => {
    const owner = startOwner('use');
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held', mode: 'use' });

    const contender = startOwner('mutation');

    await expect(contender.firstEvent).resolves.toMatchObject({
      event: 'refused',
      reason: 'active-use',
    });
  }, 60_000);

  it('refuses a use reservation while another real process holds a mutation lease', async () => {
    const owner = startOwner('mutation', ['--operation-id', 'op-real']);
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held', mode: 'mutation' });

    const contender = startOwner('use');

    await expect(contender.firstEvent).resolves.toMatchObject({
      event: 'refused',
      reason: 'operation-in-progress',
    });
  }, 60_000);

  it('refuses a second real mutation owner and admits one after the first releases', async () => {
    const first = startOwner('mutation', [
      '--operation-id',
      'op-a',
      '--candidate',
      'installation-a',
    ]);
    await expect(first.firstEvent).resolves.toMatchObject({ event: 'held' });

    const second = startOwner('mutation', [
      '--operation-id',
      'op-b',
      '--candidate',
      'installation-b',
    ]);
    await expect(second.firstEvent).resolves.toMatchObject({
      event: 'refused',
      reason: 'operation-in-progress',
    });

    await first.release();

    const third = startOwner('mutation', [
      '--operation-id',
      'op-c',
      '--candidate',
      'installation-c',
    ]);
    await expect(third.firstEvent).resolves.toMatchObject({ event: 'held' });
    // Exclusion was proved without deleting a single installation directory.
    await expect(readdir(root)).resolves.not.toContain('installation-a');
  }, 90_000);
});
