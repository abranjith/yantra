import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Browser, computeExecutablePath } from '@puppeteer/browsers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompatibilityResult, ManagedPlatform } from '../../src/browser/installation-types.js';
import { LocalManagedCoordinator } from '../../src/browser/managed-coordination.js';
import type { HelperRequest } from '../../src/browser/managed-install-types.js';
import {
  LocalManagedInstallService,
  type ManagedInstallDeps,
} from '../../src/browser/managed-install.js';
import { LocalManagedStateReader } from '../../src/browser/managed-state.js';

const BUILD_ID = '153.0.8010.36';
const PLATFORM: ManagedPlatform =
  process.platform === 'win32'
    ? 'win64'
    : process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'mac_arm'
        : 'mac'
      : 'linux';

describe('@no-llm managed install transaction', () => {
  let root: string;
  let readyPath: string;
  let state: LocalManagedStateReader;
  let coordinator: LocalManagedCoordinator;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-install-'));
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

  function consent() {
    return {
      granted: true as const,
      source: 'cli-accept-flag' as const,
      grantedAt: '2026-09-14T00:00:00.000Z',
      destinationRoot: root,
      approximateBytes: 200,
      targetBuildId: null,
      replaces: null,
    };
  }

  function compatibility(executablePath: string, failed = false): CompatibilityResult {
    return {
      schemaVersion: 1,
      identity: {
        canonicalPath: executablePath,
        version: BUILD_ID,
        majorVersion: 153,
        platform: process.platform,
        architecture: process.arch,
        statFingerprint: 'fixture',
      },
      driverVersion: '25.10.0',
      testedBuild: '152.0.7977.75',
      probeRevision: 1,
      capabilityTableHash: 'fixture',
      profile: 'automation',
      checkedAt: '2026-09-14T00:00:00.000Z',
      capabilities: [],
      verdict: failed
        ? {
            status: 'failed',
            failureClass: 'capability-failure',
            remediation: 'Install a supported browser.',
          }
        : { status: 'passed', pairing: 'capability-checked' },
    };
  }

  function service(overrides: Partial<ManagedInstallDeps> = {}) {
    const helper = {
      run: vi.fn(async (request: HelperRequest) => {
        const executablePath = computeExecutablePath({
          browser: Browser.CHROME,
          buildId: BUILD_ID,
          platform: request.platform as never,
          cacheDir: request.cacheDir,
        });
        await mkdir(dirname(executablePath), { recursive: true });
        await writeFile(executablePath, 'fixture');
        await chmod(executablePath, 0o700);
        return {
          status: 'completed' as const,
          buildId: BUILD_ID,
          executableRelative: executablePath.slice(request.cacheDir.length + 1),
        };
      }),
    };
    const candidateProbe = {
      probeManagedCandidate: vi.fn(async (permit: { executablePath: string }) =>
        compatibility(permit.executablePath),
      ),
    };
    return {
      instance: new LocalManagedInstallService({
        state,
        coordinator,
        helper,
        candidateProbe,
        root: () => root,
        candidateRoot: (id) => join(root, `installation-${id}`),
        readyPath: () => readyPath,
        preflight: async () => ({ platform: PLATFORM, archiveTools: ['fixture'] }),
        id: () => 'candidate',
        clock: () => new Date('2026-09-14T00:00:00.000Z'),
        ...overrides,
      }),
      helper,
      candidateProbe,
    };
  }

  it('publishes one verified installation atomically and leaves zero orphans', async () => {
    const { instance } = service();
    const outcome = await instance.install({ trigger: 'explicit-command', consent: consent() });
    expect(outcome.status).toBe('installed');
    const record = JSON.parse(await readFile(readyPath, 'utf8')) as { cacheRootRelative: string };
    expect(record.cacheRootRelative).toBe('installation-candidate');
    expect((await state.readInventory()).orphans).toEqual([]);
    expect((await readdir(root)).filter((name) => name.startsWith('installation-'))).toEqual([
      'installation-candidate',
    ]);
  });

  it('collects a pre-existing orphan before creating the candidate', async () => {
    await mkdir(join(root, 'installation-old'));
    await writeFile(join(root, 'installation-old', 'old.bin'), 'old');
    const { instance } = service();
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toMatchObject({ status: 'installed' });
    await expect(stat(join(root, 'installation-old'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is an idempotent local success and makes no second helper call', async () => {
    const { instance, helper } = service();
    await instance.install({ trigger: 'explicit-command', consent: consent() });
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toMatchObject({
      status: 'already-installed',
      updateCommand: 'yantra browser update',
    });
    expect(helper.run).toHaveBeenCalledOnce();
  });

  it('rejects absent consent before claiming a lease or invoking the helper', async () => {
    const claim = vi.spyOn(coordinator, 'claimMutation');
    const { instance, helper } = service();
    const outcome = await instance.install({ trigger: 'explicit-command' } as never);
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'consent-required' } });
    expect(claim).not.toHaveBeenCalled();
    expect(helper.run).not.toHaveBeenCalled();
  });

  it('returns cancellation and retains the candidate for next-run collection', async () => {
    const { instance } = service({
      helper: {
        run: vi.fn(async () => ({ status: 'cancelled' as const, at: 'downloading' as const })),
      },
    });
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toEqual({
      status: 'cancelled',
      at: 'downloading',
      retainedOrphan: 'installation-candidate',
    });
    await expect(readFile(readyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps an unverified candidate as an orphan without publishing it', async () => {
    const { instance } = service({
      helper: {
        run: vi.fn(async () => ({
          status: 'completed' as const,
          buildId: BUILD_ID,
          executableRelative: 'missing',
        })),
      },
    });
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'verification-failure', retainedOrphan: 'installation-candidate' },
    });
    await expect(readFile(readyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not expose a partial pointer when atomic rename fails', async () => {
    const { instance } = service({
      renameReady: vi.fn().mockRejectedValue(new Error('disk offline')) as never,
    });
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toMatchObject({ status: 'failed', error: { code: 'publication-failure' } });
    await expect(readFile(readyPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('uses the explicit candidate-probe port without a concrete compatibility cast', async () => {
    const candidateProbe = {
      probeManagedCandidate: vi.fn(async (permit: { executablePath: string }) =>
        compatibility(permit.executablePath, true),
      ),
    };
    const { instance } = service({ candidateProbe });
    await expect(
      instance.install({ trigger: 'explicit-command', consent: consent() }),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'compatibility-failure', probeFailure: 'capability-failure' },
    });
    expect(candidateProbe.probeManagedCandidate).toHaveBeenCalledOnce();
  });
});
