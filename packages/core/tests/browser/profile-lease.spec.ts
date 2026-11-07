import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetPathCache } from '../../src/browser/paths.js';
import { LocalProfileStore } from '../../src/browser/profile-store.js';
import type { ResolvedProfile } from '../../src/browser/types.js';
import { probeResourceLock, ResourceBusyError } from '../../src/locks/resource-lock.js';

describe('@no-llm persistent browser profile leases', () => {
  let root: string;
  let previousHome: string | undefined;
  let store: LocalProfileStore;
  const resolved: ResolvedProfile[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-profile-lease-'));
    previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    store = new LocalProfileStore({
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
      },
    });
  });
  afterEach(async () => {
    for (const profile of resolved.splice(0)) {
      await profile.lease?.release();
      if (profile.kind === 'ephemeral') await store.cleanupEphemeral(profile.absolutePath);
    }
    if (previousHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previousHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a second workflow profile immediately and admits a run after release', async () => {
    const first = await store.resolve({ kind: 'workflow', workflowName: 'bank' });
    resolved.push(first);
    await expect(store.resolve({ kind: 'workflow', workflowName: 'bank' })).rejects.toMatchObject({
      name: 'ResourceBusyError',
      holder: { pid: process.pid },
    });
    expect(await probeResourceLock({ kind: 'browser-profile', path: first.absolutePath })).toEqual(
      first.lease?.owner,
    );
    expect((await store.listWorkflowProfiles()).map((profile) => profile.workflowName)).toEqual([
      'bank',
    ]);
    await first.lease?.release();
    const third = await store.resolve({ kind: 'workflow', workflowName: 'bank' });
    resolved.push(third);
    expect(third.lease).toBeDefined();
  });

  it('admits one explicit directory owner and coordinates directory aliases', async () => {
    const path = join(root, 'manual');
    const alias = join(root, 'alias');
    await mkdir(path, { mode: 0o700 });
    await symlink(path, alias, 'junction');
    const first = await store.resolve({ kind: 'explicit', absolutePath: path });
    resolved.push(first);
    await expect(store.resolve({ kind: 'explicit', absolutePath: path })).rejects.toBeInstanceOf(
      ResourceBusyError,
    );
    await expect(store.resolve({ kind: 'explicit', absolutePath: alias })).rejects.toBeInstanceOf(
      ResourceBusyError,
    );
    expect(await probeResourceLock({ kind: 'browser-profile', path: alias })).toEqual(
      first.lease?.owner,
    );
    await first.lease?.release();
    const next = await store.resolve({ kind: 'explicit', absolutePath: alias });
    resolved.push(next);
    expect(next.absolutePath).toBe(alias);
  });

  it('never leases or contends for ephemeral profiles', async () => {
    const profiles = await Promise.all([
      store.resolve({ kind: 'ephemeral' }),
      store.resolve({ kind: 'ephemeral' }),
    ]);
    resolved.push(...profiles);
    expect(profiles[0]?.absolutePath).not.toBe(profiles[1]?.absolutePath);
    for (const profile of profiles) {
      expect(profile.lease).toBeUndefined();
      expect(
        await probeResourceLock({ kind: 'browser-profile', path: profile.absolutePath }),
      ).toBeNull();
    }
  });
});
