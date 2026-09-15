/**
 * The consented replacement transaction.
 *
 * Every case here asserts on-disk state after the fact — which pointer exists,
 * which children remain, whether the previous executable still resolves — never
 * on a sequence of mocked calls. The two failures this feature can have are
 * "the pointer moved when it should not have" and "the previous installation
 * stopped working", and neither is visible in a call log.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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

describe('@no-llm managed update transaction', () => {
  let root: string;
  let readyPath: string;
  let state: LocalManagedStateReader;
  let coordinator: LocalManagedCoordinator;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-update-'));
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
    await rm(root, { recursive: true, force: true });
  });

  function build(buildId = STABLE): StableBuild {
    return {
      buildId,
      platform: PLATFORM,
      resolvedAt: '2026-09-14T00:00:00.000Z',
      artifactAvailable: true,
    };
  }

  function consent(targetBuildId: string | null = STABLE, replaces: string | null = INSTALLED) {
    return {
      granted: true as const,
      source: 'cli-update-prompt' as const,
      grantedAt: '2026-09-14T00:00:00.000Z',
      destinationRoot: root,
      approximateBytes: 200,
      targetBuildId,
      replaces,
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
      // The normal case: Chrome ships Stable faster than the driver is bumped.
      verdict: { status: 'passed', pairing: 'capability-checked' },
    };
  }

  /** Materializes an existing ready installation, executable included. */
  async function installExisting(buildId = INSTALLED): Promise<ManagedReadyRecord> {
    const child = join(root, 'installation-previous');
    const executablePath = computeExecutablePath({
      browser: Browser.CHROME,
      buildId,
      platform: PLATFORM as never,
      cacheDir: child,
    });
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(executablePath, 'previous');
    await chmod(executablePath, 0o700);
    const record: ManagedReadyRecord = {
      schemaVersion: 1,
      installationId: 'previous',
      browser: 'chrome',
      platform: PLATFORM,
      buildId,
      cacheRootRelative: 'installation-previous',
      executableRelative: executablePath.slice(child.length + 1),
      verifiedAt: '2026-09-14T00:00:00.000Z',
    };
    await writeFile(readyPath, JSON.stringify(record));
    return record;
  }

  function services(
    overrides: {
      readonly helperOutcome?: (request: HelperRequest) => Promise<unknown>;
      readonly probeFails?: boolean;
      readonly resolveStable?: StableResolutionService['resolveStable'];
      readonly renameReady?: typeof rename;
    } = {},
  ) {
    const helper = {
      run: vi.fn(async (request: HelperRequest) => {
        if (overrides.helperOutcome) return overrides.helperOutcome(request) as never;
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
    const candidateProbe = {
      probeManagedCandidate: vi.fn(async (permit: { executablePath: string }) =>
        overrides.probeFails
          ? {
              ...compatibility(permit.executablePath),
              verdict: {
                status: 'failed' as const,
                failureClass: 'capability-failure' as const,
                remediation: 'Install a supported browser.',
              },
            }
          : compatibility(permit.executablePath),
      ),
    };
    const acquisition = new LocalManagedInstallService({
      state,
      coordinator,
      helper,
      candidateProbe,
      root: () => root,
      candidateRoot: (id) => join(root, `installation-${id}`),
      readyPath: () => readyPath,
      preflight: async () => ({ platform: PLATFORM, archiveTools: ['fixture'] }),
      clock: () => new Date('2026-09-14T00:00:00.000Z'),
      ...(overrides.renameReady ? { renameReady: overrides.renameReady } : {}),
    });
    const availability: StableResolutionService = {
      resolveStable:
        overrides.resolveStable ??
        vi.fn(async () => ({ status: 'resolved' as const, build: build() })),
    };
    const instance = new LocalManagedUpdateService({
      state,
      coordinator,
      acquisition,
      availability,
      root: () => root,
      id: () => 'candidate',
    });
    return { instance, helper, candidateProbe, acquisition, availability };
  }

  function request(overrides: Partial<ManagedUpdateRequest> = {}): ManagedUpdateRequest {
    return { consent: consent(), target: build(), ...overrides };
  }

  async function installationChildren(): Promise<readonly string[]> {
    return (await readdir(root)).filter((name) => name.startsWith('installation-')).sort();
  }

  // -------------------------------------------------------------------------
  // The single acquisition path
  // -------------------------------------------------------------------------

  it('replaces the installation, leaving one pointer, one child, and zero orphans', async () => {
    const previous = await installExisting();
    const { instance } = services();

    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({
      status: 'replaced',
      previousBuildId: previous.buildId,
      record: { buildId: STABLE, cacheRootRelative: 'installation-candidate' },
    });
    const pointer = JSON.parse(await readFile(readyPath, 'utf8')) as ManagedReadyRecord;
    expect(pointer.buildId).toBe(STABLE);
    expect(await installationChildren()).toEqual(['installation-candidate']);
    expect((await state.readInventory()).orphans).toEqual([]);
    // The new executable resolves by recomputation, not from a stored absolute.
    if (outcome.status !== 'replaced') throw new Error('expected a replacement');
    await expect(stat(outcome.executablePath)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it('collects the superseded child rather than keeping a second selectable build', async () => {
    await installExisting();
    const { instance } = services();
    await instance.update(request());
    await expect(stat(join(root, 'installation-previous'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('hands the helper the exact build the user consented to', async () => {
    await installExisting();
    const { instance, helper } = services();
    await instance.update(request());
    expect(helper.run.mock.calls[0]![0]).toMatchObject({
      mode: 'install',
      protocolVersion: 2,
      buildId: STABLE,
    });
  });

  it('routes install and update through one acquisition implementation', async () => {
    await installExisting();
    const { instance, acquisition } = services();
    // Spied on the instance, not through an outer wrapper: an internal
    // `this.method()` call does not resolve through a decorator.
    const acquire = vi.spyOn(acquisition, 'acquireAndPublish');
    await instance.update(request());
    expect(acquire).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Preconditions
  // -------------------------------------------------------------------------

  it('refuses without a managed installation before any metadata call', async () => {
    const resolveStable = vi.fn();
    const { instance, helper } = services({ resolveStable });
    const outcome = await instance.update(request());
    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'no-managed-installation', remediation: expect.stringContaining('install') },
      record: { status: 'absent' },
    });
    expect(resolveStable).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
  });

  it('reports an invalid ready record as no managed installation, preserving the reason', async () => {
    await writeFile(readyPath, '{ not json');
    const { instance } = services();
    const outcome = await instance.update(request());
    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'no-managed-installation', detail: expect.stringContaining('JSON') },
    });
  });

  it('refuses consent naming a different build before any lease or download', async () => {
    await installExisting();
    const { instance, helper } = services();
    const claim = vi.spyOn(coordinator, 'claimMutation');

    const outcome = await instance.update(request({ consent: consent('153.0.9999.1', INSTALLED) }));

    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'consent-build-mismatch' },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
    expect(await installationChildren()).toEqual(['installation-previous']);
  });

  it('refuses consent naming a different installed build', async () => {
    await installExisting();
    const { instance } = services();
    await expect(
      instance.update(request({ consent: consent(STABLE, '151.0.0.0') })),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'consent-build-mismatch' } });
  });

  it('refuses absent consent', async () => {
    await installExisting();
    const { instance, helper } = services();
    await expect(instance.update({ target: build() } as never)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'consent-required' },
    });
    expect(helper.run).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // No-op verdicts
  // -------------------------------------------------------------------------

  it('reports up-to-date without taking a lease or downloading', async () => {
    await installExisting(STABLE);
    const { instance, helper } = services();
    const claim = vi.spyOn(coordinator, 'claimMutation');

    await expect(
      instance.update(request({ consent: consent(STABLE, STABLE) })),
    ).resolves.toMatchObject({ status: 'up-to-date', record: { buildId: STABLE } });

    expect(claim).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
  });

  it('never downgrades: installed-newer reports both identities and mutates nothing', async () => {
    await installExisting('154.0.1.0');
    const { instance, helper } = services();
    const claim = vi.spyOn(coordinator, 'claimMutation');

    const outcome = await instance.update(request({ consent: consent(STABLE, '154.0.1.0') }));

    expect(outcome).toMatchObject({
      status: 'installed-newer',
      record: { buildId: '154.0.1.0' },
      available: { buildId: STABLE },
    });
    expect(claim).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
    expect(await installationChildren()).toEqual(['installation-previous']);
  });

  // -------------------------------------------------------------------------
  // Failure and interruption preserve prior readiness
  // -------------------------------------------------------------------------

  it.each([
    [
      'download',
      async () => {
        throw new Error('transfer failed');
      },
    ],
    [
      'verification',
      // Completes without producing an executable at the computed path.
      async () => ({ status: 'completed' as const, buildId: STABLE, executableRelative: 'nope' }),
    ],
  ] as const)(
    'keeps the previous installation launchable when %s fails, leaving one collectable orphan',
    async (_phase, helperOutcome) => {
      const previous = await installExisting();
      const { instance } = services({ helperOutcome: helperOutcome as never });

      const outcome = await instance.update(request());

      expect(outcome).toMatchObject({
        status: 'failed',
        record: { status: 'ready', record: { buildId: previous.buildId } },
      });
      // The pointer never moved, and the executable it names is still there.
      const pointer = JSON.parse(await readFile(readyPath, 'utf8')) as ManagedReadyRecord;
      expect(pointer.buildId).toBe(previous.buildId);
      await expect(
        stat(join(root, pointer.cacheRootRelative, pointer.executableRelative)),
      ).resolves.toMatchObject({ size: expect.any(Number) });
      const orphans = (await state.readInventory()).orphans;
      expect(orphans.map((orphan) => orphan.cacheRootRelative)).toEqual(['installation-candidate']);
    },
  );

  it('keeps the previous installation when the candidate fails its capability probe', async () => {
    const previous = await installExisting();
    const { instance } = services({ probeFails: true });

    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({
      status: 'failed',
      error: { code: 'compatibility-failure' },
      record: { status: 'ready', record: { buildId: previous.buildId } },
    });
    expect(JSON.parse(await readFile(readyPath, 'utf8'))).toMatchObject({
      buildId: previous.buildId,
    });
  });

  it('never exposes a partial pointer when the atomic publish fails', async () => {
    const previous = await installExisting();
    const { instance } = services({
      renameReady: (async () => {
        throw new Error('rename refused');
      }) as never,
    });

    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'publication-failure' } });
    expect(JSON.parse(await readFile(readyPath, 'utf8'))).toMatchObject({
      buildId: previous.buildId,
    });
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports cancellation with the surviving installation and a retained orphan', async () => {
    const previous = await installExisting();
    const { instance } = services({
      helperOutcome: async () => ({ status: 'cancelled' as const, at: 'downloading' as const }),
    });

    await expect(instance.update(request())).resolves.toMatchObject({
      status: 'cancelled',
      at: 'downloading',
      retainedOrphan: 'installation-candidate',
      record: { buildId: previous.buildId },
    });
    expect(JSON.parse(await readFile(readyPath, 'utf8'))).toMatchObject({
      buildId: previous.buildId,
    });
  });

  it('collects an abandoned candidate on the next explicit update and reports the bytes', async () => {
    await installExisting();
    const abandoned = join(root, 'installation-killed');
    await mkdir(abandoned, { recursive: true });
    await writeFile(join(abandoned, 'partial.bin'), 'x'.repeat(2_048));
    const { instance } = services();

    const outcome = await instance.update(request());

    expect(outcome).toMatchObject({ status: 'replaced' });
    await expect(stat(abandoned)).rejects.toMatchObject({ code: 'ENOENT' });
    if (outcome.status !== 'replaced') throw new Error('expected a replacement');
    expect(outcome.orphans.bytesReclaimed).toBeGreaterThan(0);
  });

  it('never reports success while an orphan remains selectable', async () => {
    await installExisting();
    const { instance } = services();
    const outcome = await instance.update(request());
    expect(outcome.status).toBe('replaced');
    // Selection reads the pointer, so an orphan is unselectable by construction.
    const inventory = await state.readInventory();
    expect(inventory.ready.status).toBe('ready');
    expect(inventory.orphans).toEqual([]);
  });

  it('writes no config key and touches no external installation', async () => {
    await installExisting();
    const external = join(root, 'external-chrome');
    await writeFile(external, 'not-ours');
    const { instance } = services();

    await instance.update(request());

    await expect(readFile(external, 'utf8')).resolves.toBe('not-ours');
    expect((await readdir(root)).filter((name) => name.endsWith('.yaml'))).toEqual([]);
  });

  it('resolves the replaced executable after the data root is relocated', async () => {
    await installExisting();
    const { instance } = services();
    const outcome = await instance.update(request());
    if (outcome.status !== 'replaced') throw new Error('expected a replacement');

    const moved = await mkdtemp(join(tmpdir(), 'yantra-update-moved-'));
    try {
      const relocatedState = new LocalManagedStateReader({
        root: () => moved,
        readyPath: () => join(moved, 'ready.json'),
      });
      await writeFile(join(moved, 'ready.json'), JSON.stringify(outcome.record));
      const child = join(moved, outcome.record.cacheRootRelative);
      const relocatedExecutable = computeExecutablePath({
        browser: Browser.CHROME,
        buildId: outcome.record.buildId,
        platform: PLATFORM as never,
        cacheDir: child,
      });
      await mkdir(dirname(relocatedExecutable), { recursive: true });
      await writeFile(relocatedExecutable, 'candidate');

      const snapshot = await relocatedState.readReady();
      expect(snapshot.status).toBe('ready');
      const { managedExecutablePath } = await import('../../src/browser/managed-state.js');
      if (snapshot.status !== 'ready') throw new Error('expected a ready record');
      const recomputed = managedExecutablePath(snapshot.record, moved);
      expect(recomputed.agrees).toBe(true);
      await expect(stat(recomputed.path)).resolves.toMatchObject({ size: expect.any(Number) });
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  });
});
