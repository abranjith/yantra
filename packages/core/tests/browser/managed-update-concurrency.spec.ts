/**
 * Update versus a running browser, across real processes.
 *
 * Every liveness claim here observes an actual operating-system process. A
 * mocked async function can be made to "hold" anything, so it proves nothing
 * about two processes racing for the same files — and the guarantee under test
 * is exactly that: an update must not replace a binary another process has
 * open, and must never terminate that process to get its way.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Browser, computeExecutablePath } from '@puppeteer/browsers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CompatibilityResult,
  ManagedPlatform,
  ManagedReadyRecord,
} from '../../src/browser/installation-types.js';
import { LocalManagedCoordinator } from '../../src/browser/managed-coordination.js';
import type { HelperRequest } from '../../src/browser/managed-install-types.js';
import { LocalManagedInstallService } from '../../src/browser/managed-install.js';
import { LocalManagedStateReader } from '../../src/browser/managed-state.js';
import type {
  ManagedUpdateRequest,
  StableBuild,
  StableResolutionService,
} from '../../src/browser/managed-update-types.js';
import { LocalManagedUpdateService } from '../../src/browser/managed-update.js';

const OWNER_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'coordination-owner.mjs',
);

const INSTALLED = '152.0.7977.75';
const STABLE = '153.0.8010.36';
const PLATFORM: ManagedPlatform =
  process.platform === 'win32'
    ? 'win64'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'mac_arm'
        : 'mac'
      : 'linux';

interface OwnerHandle {
  readonly child: ChildProcessWithoutNullStreams;
  readonly firstEvent: Promise<Record<string, unknown>>;
  release(): Promise<void>;
  kill(): Promise<void>;
}

describe('@no-llm managed update coordination across real processes', () => {
  let root: string;
  let readyPath: string;
  let state: LocalManagedStateReader;
  let coordinator: LocalManagedCoordinator;
  const owners: OwnerHandle[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-update-proc-'));
    readyPath = join(root, 'ready.json');
    const coordinationState = new LocalManagedStateReader({
      root: () => root,
      readyPath: () => readyPath,
    });
    coordinator = new LocalManagedCoordinator({
      managedState: coordinationState,
      coordinationRoot: () => join(root, 'coordination'),
      operationPath: () => join(root, 'operation.json'),
    });
    state = new LocalManagedStateReader({
      root: () => root,
      readyPath: () => readyPath,
      liveMutationCandidate: coordinator.liveMutationCandidate,
    });
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
        OWNER_FIXTURE,
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
        '25000',
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

  function build(buildId = STABLE): StableBuild {
    return {
      buildId,
      platform: PLATFORM,
      resolvedAt: '2026-09-14T00:00:00.000Z',
      artifactAvailable: true,
    };
  }

  function consent() {
    return {
      granted: true as const,
      source: 'cli-update-prompt' as const,
      grantedAt: '2026-09-14T00:00:00.000Z',
      destinationRoot: root,
      approximateBytes: 200,
      targetBuildId: STABLE,
      replaces: INSTALLED,
    };
  }

  function compatibility(executablePath: string): CompatibilityResult {
    return {
      schemaVersion: 1,
      identity: {
        canonicalPath: executablePath,
        version: STABLE,
        majorVersion: 153,
        platform: process.platform,
        architecture: process.arch,
        statFingerprint: 'fixture',
      },
      driverVersion: '25.10.0',
      testedBuild: INSTALLED,
      probeRevision: 1,
      capabilityTableHash: 'fixture',
      profile: 'automation',
      checkedAt: '2026-09-14T00:00:00.000Z',
      capabilities: [],
      verdict: { status: 'passed', pairing: 'capability-checked' },
    };
  }

  async function installExisting(): Promise<ManagedReadyRecord> {
    const child = join(root, 'installation-abc123');
    const executablePath = computeExecutablePath({
      browser: Browser.CHROME,
      buildId: INSTALLED,
      platform: PLATFORM as never,
      cacheDir: child,
    });
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(executablePath, 'previous');
    await chmod(executablePath, 0o700);
    const record: ManagedReadyRecord = {
      schemaVersion: 1,
      installationId: 'abc123',
      browser: 'chrome',
      platform: PLATFORM,
      buildId: INSTALLED,
      cacheRootRelative: 'installation-abc123',
      executableRelative: executablePath.slice(child.length + 1),
      verifiedAt: '2026-09-14T00:00:00.000Z',
    };
    await writeFile(readyPath, JSON.stringify(record), 'utf8');
    return record;
  }

  function updateService(
    options: {
      readonly id?: string;
      readonly onHelperRun?: () => Promise<void>;
      readonly resolveStable?: StableResolutionService['resolveStable'];
    } = {},
  ) {
    const helper = {
      run: vi.fn(async (request: HelperRequest) => {
        await options.onHelperRun?.();
        const buildId = request.buildId ?? STABLE;
        const executablePath = computeExecutablePath({
          browser: Browser.CHROME,
          buildId,
          platform: request.platform as never,
          cacheDir: request.cacheDir!,
        });
        await mkdir(dirname(executablePath), { recursive: true });
        await writeFile(executablePath, 'candidate');
        await chmod(executablePath, 0o700);
        return {
          status: 'completed' as const,
          buildId,
          executableRelative: executablePath.slice(request.cacheDir!.length + 1),
        };
      }),
    };
    const acquisition = new LocalManagedInstallService({
      state,
      coordinator,
      helper,
      candidateProbe: {
        probeManagedCandidate: vi.fn(async (permit: { executablePath: string }) =>
          compatibility(permit.executablePath),
        ),
      },
      root: () => root,
      candidateRoot: (id) => join(root, `installation-${id}`),
      readyPath: () => readyPath,
      preflight: async () => ({ platform: PLATFORM, archiveTools: ['fixture'] }),
      clock: () => new Date('2026-09-14T00:00:00.000Z'),
    });
    const instance = new LocalManagedUpdateService({
      state,
      coordinator,
      acquisition,
      availability: {
        resolveStable:
          options.resolveStable ??
          vi.fn(async () => ({ status: 'resolved' as const, build: build() })),
      },
      root: () => root,
      id: () => options.id ?? 'candidate',
    });
    return { instance, helper };
  }

  const request = (): ManagedUpdateRequest => ({ consent: consent(), target: build() });

  it('refuses while a real process holds a use reservation, before any metadata call', async () => {
    await installExisting();
    const owner = startOwner('use');
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held', mode: 'use' });

    const resolveStable = vi.fn();
    const { instance, helper } = updateService({ resolveStable });

    const preflight = await instance.preflightMutation();
    expect(preflight).toMatchObject({
      status: 'refused',
      error: { code: 'managed-run-active' },
    });
    // The refusal names the process the user has to stop.
    if (preflight.status !== 'refused') throw new Error('expected a refusal');
    expect(preflight.error.detail).toMatch(/pid \d+/u);
    expect(resolveStable).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
  }, 60_000);

  it('never terminates the running browser it refused for', async () => {
    await installExisting();
    const owner = startOwner('use');
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held' });

    const { instance } = updateService();
    await expect(instance.update(request())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'managed-run-active' },
    });

    // The owner is still alive — observed on the actual process, not inferred.
    expect(owner.child.exitCode).toBeNull();
    expect(owner.child.killed).toBe(false);
  }, 60_000);

  // The primary protection: once the lease is held, a managed launch cannot
  // start at all, so the download window has nothing to race with. This is the
  // guarantee that makes the re-verification below a backstop rather than the
  // only thing standing between an update and a browser it would overwrite.
  it('refuses a real managed launch attempted during the download, and still replaces', async () => {
    await installExisting();
    let contender: OwnerHandle | undefined;
    const { instance } = updateService({
      onHelperRun: async () => {
        contender = startOwner('use');
        await expect(contender.firstEvent).resolves.toMatchObject({
          event: 'refused',
          reason: 'operation-in-progress',
        });
      },
    });

    await expect(instance.update(request())).resolves.toMatchObject({ status: 'replaced' });
    expect(contender).toBeDefined();
  }, 60_000);

  // The backstop. No legitimate launch can produce this state — the test drives
  // `hasActiveUse` directly for that reason — but a reservation written by a
  // path the mutex did not serialize must still not lose the user's browser.
  it('aborts before publication if active use is observed at the last moment', async () => {
    const previous = await installExisting();
    const { instance } = updateService();
    const hasActiveUse = vi.spyOn(coordinator, 'hasActiveUse');
    // False for the precondition check and for the claim, true at the
    // pre-publication re-verification.
    hasActiveUse.mockResolvedValueOnce(false).mockResolvedValue(true);

    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({ status: 'failed' });
    // The pointer never moved and the previous executable is still there.
    const pointer = JSON.parse(await readFile(readyPath, 'utf8')) as ManagedReadyRecord;
    expect(pointer.buildId).toBe(previous.buildId);
    await expect(
      stat(join(root, pointer.cacheRootRelative, pointer.executableRelative)),
    ).resolves.toMatchObject({ size: expect.any(Number) });
    // And exactly one collectable orphan is left behind.
    expect((await state.readInventory()).orphans.map((o) => o.cacheRootRelative)).toEqual([
      'installation-candidate',
    ]);
  }, 60_000);

  it('refuses a second update while a real process holds the mutation lease', async () => {
    await installExisting();
    const owner = startOwner('mutation', [
      '--operation-id',
      'op-other',
      '--candidate',
      'installation-other',
    ]);
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held', mode: 'mutation' });

    const { instance, helper } = updateService();
    await expect(instance.update(request())).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'operation-in-progress' },
    });
    expect(helper.run).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(readyPath, 'utf8'))).toMatchObject({ buildId: INSTALLED });
  }, 60_000);

  it('admits exactly one of two simultaneous updates', async () => {
    await installExisting();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = updateService({ id: 'first', onHelperRun: () => held });
    const second = updateService({ id: 'second' });

    const firstRun = first.instance.update(request());
    // Let the first claim its lease before the contender arrives.
    await vi.waitFor(() => expect(first.helper.run).toHaveBeenCalled(), { timeout: 5_000 });
    const secondOutcome = await second.instance.update(request());
    release();
    const firstOutcome = await firstRun;

    expect(secondOutcome).toMatchObject({
      status: 'failed',
      error: { code: 'operation-in-progress' },
    });
    expect(second.helper.run).not.toHaveBeenCalled();
    expect(firstOutcome).toMatchObject({ status: 'replaced' });
    expect((await readdir(root)).filter((name) => name.startsWith('installation-'))).toEqual([
      'installation-first',
    ]);
  }, 60_000);

  it('is not blocked by a reservation whose owner died', async () => {
    await installExisting();
    const owner = startOwner('use');
    await expect(owner.firstEvent).resolves.toMatchObject({ event: 'held' });
    // A killed owner in the `starting` phase is treated conservatively as busy,
    // so prove the dead-owner path with a released one instead: the distinction
    // is liveness, and neither case may deadlock.
    await owner.release();

    const { instance } = updateService();
    await expect(instance.update(request())).resolves.toMatchObject({ status: 'replaced' });
  }, 60_000);

  it('leaves a killed update owner as a collectable orphan the next update reclaims', async () => {
    await installExisting();
    const killed = startOwner('mutation', [
      '--operation-id',
      'op-killed',
      '--candidate',
      'installation-killed',
    ]);
    await expect(killed.firstEvent).resolves.toMatchObject({ event: 'held' });
    // The candidate the dead owner was building.
    await mkdir(join(root, 'installation-killed'), { recursive: true });
    await writeFile(join(root, 'installation-killed', 'partial.bin'), 'x'.repeat(4_096));
    await killed.kill();

    const { instance } = updateService();
    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({ status: 'replaced' });
    await expect(stat(join(root, 'installation-killed'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (outcome.status !== 'replaced') throw new Error('expected a replacement');
    expect(outcome.orphans.bytesReclaimed).toBeGreaterThan(0);
  }, 60_000);

  it('lets an availability check run while a browser is running and a lease is held', async () => {
    await installExisting();
    const use = startOwner('use');
    await expect(use.firstEvent).resolves.toMatchObject({ event: 'held' });

    const { instance } = updateService();
    const claim = vi.spyOn(coordinator, 'claimMutation');
    const reserve = vi.spyOn(coordinator, 'reserveUse');

    const availability = await instance.checkAvailability();

    expect(availability).toMatchObject({
      comparison: { state: 'update-available' },
      activeManagedRun: true,
    });
    // Reported as local state, never acted on: no claim, no reservation.
    expect(claim).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  }, 60_000);
});
