import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalManagedCoordinator } from '../../src/browser/managed-coordination.js';
import { LocalManagedInstallService } from '../../src/browser/managed-install.js';
import { LocalManagedStateReader } from '../../src/browser/managed-state.js';

describe('@no-llm managed installation concurrency', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('admits one of two simultaneous installs and refuses the contender before helper I/O', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-install-race-'));
    roots.push(root);
    const readyPath = join(root, 'ready.json');
    const coordinationState = new LocalManagedStateReader({
      root: () => root,
      readyPath: () => readyPath,
    });
    const coordinator = new LocalManagedCoordinator({
      managedState: coordinationState,
      coordinationRoot: () => join(root, 'coordination'),
      operationPath: () => join(root, 'operation.json'),
    });
    const state = new LocalManagedStateReader({
      root: () => root,
      readyPath: () => readyPath,
      liveMutationCandidate: coordinator.liveMutationCandidate,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstHelper = {
      run: vi.fn(async () => {
        await held;
        return { status: 'cancelled' as const, at: 'downloading' as const };
      }),
    };
    const secondHelper = { run: vi.fn() };
    const common = {
      state,
      coordinator,
      root: () => root,
      candidateRoot: (id: string) => join(root, `installation-${id}`),
      readyPath: () => readyPath,
      preflight: async () => ({ platform: 'linux' as const, archiveTools: ['fixture'] }),
      candidateProbe: { probeManagedCandidate: vi.fn() },
    };
    const first = new LocalManagedInstallService({
      ...common,
      helper: firstHelper,
      id: () => 'first',
    });
    const second = new LocalManagedInstallService({
      ...common,
      helper: secondHelper,
      id: () => 'second',
    });
    const consent = {
      granted: true as const,
      source: 'cli-accept-flag' as const,
      grantedAt: '2026-09-14T00:00:00.000Z',
      destinationRoot: root,
      approximateBytes: 1,
      targetBuildId: null,
      replaces: null,
    };

    const active = first.install({ trigger: 'explicit-command', consent });
    await vi.waitFor(() => expect(firstHelper.run).toHaveBeenCalledOnce(), { timeout: 5_000 });
    await expect(second.install({ trigger: 'explicit-command', consent })).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'operation-in-progress' },
    });
    expect(secondHelper.run).not.toHaveBeenCalled();
    release();
    await expect(active).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('refuses installation when a managed use reservation is active', async () => {
    const helper = { run: vi.fn() };
    const service = new LocalManagedInstallService({
      state: {
        readReady: vi.fn().mockResolvedValue({ status: 'absent' }),
        readInventory: vi.fn().mockResolvedValue({ ready: { status: 'absent' }, orphans: [] }),
      },
      coordinator: {
        reserveUse: vi.fn(),
        hasActiveUse: vi.fn(),
        claimMutation: vi.fn().mockRejectedValue(new Error('active managed run')),
      },
      helper,
      candidateProbe: { probeManagedCandidate: vi.fn() },
    });
    const outcome = await service.install({
      trigger: 'explicit-command',
      consent: {
        granted: true,
        source: 'cli-accept-flag',
        grantedAt: '2026-09-14T00:00:00.000Z',
        destinationRoot: '/managed',
        approximateBytes: 1,
        targetBuildId: null,
        replaces: null,
      },
    });
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'operation-in-progress' } });
    expect(helper.run).not.toHaveBeenCalled();
  });

  it('preserves no-op installation and refuses mutations with a real managed-use reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-install-use-'));
    roots.push(root);
    const record = {
      schemaVersion: 1 as const,
      installationId: 'active',
      browser: 'chrome' as const,
      platform: 'linux' as const,
      buildId: '150.0.0.0',
      cacheRootRelative: 'installation-active',
      executableRelative: 'chrome/linux-150.0.0.0/chrome-linux64/chrome',
      verifiedAt: '2026-09-14T00:00:00.000Z',
    };
    const state = {
      readReady: async () => ({ status: 'ready' as const, record }),
      readInventory: async () => ({ ready: { status: 'ready' as const, record }, orphans: [] }),
    };
    const self = { pid: process.pid, startToken: 'fixture-creation-token' };
    const coordinator = new LocalManagedCoordinator({
      managedState: state,
      coordinationRoot: () => join(root, 'coordination'),
      operationPath: () => join(root, 'operation.json'),
      selfIdentity: async () => self,
      liveness: {
        identify: async () => self,
        check: async (identity) =>
          identity.pid === self.pid && identity.startToken === self.startToken ? 'alive' : 'dead',
      },
    });
    const reservation = await coordinator.reserveUse(record);
    const helper = { run: vi.fn() };
    try {
      const service = new LocalManagedInstallService({
        state,
        coordinator,
        root: () => root,
        helper,
        candidateProbe: { probeManagedCandidate: vi.fn() },
      });
      const outcome = await service.install({
        trigger: 'explicit-command',
        consent: {
          granted: true,
          source: 'cli-accept-flag',
          grantedAt: '2026-09-14T00:00:00.000Z',
          destinationRoot: root,
          approximateBytes: 1,
          targetBuildId: null,
          replaces: null,
        },
      });
      expect(outcome).toMatchObject({ status: 'already-installed' });
      expect(helper.run).not.toHaveBeenCalled();
      await expect(
        coordinator.claimMutation('fixture-install', 'installation-candidate'),
      ).rejects.toMatchObject({ context: { reason: 'active-use' } });
    } finally {
      await reservation.markNeverSpawned();
    }
  });
});
