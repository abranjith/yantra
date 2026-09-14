import { constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MANAGED_INSTALL_POLICY } from '../../src/browser/managed-install-types.js';
import {
  archiveToolPaths,
  managedPreflight,
  stripProxyCredentials,
} from '../../src/browser/managed-preflight.js';

describe('@no-llm managed install preflight', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'yantra-preflight-'));
    roots.push(value);
    return value;
  }
  const enoughSpace = vi.fn(async () => ({ bavail: 2_000_000, bsize: 1_024 })) as never;

  it('rejects an unsupported host before archive or network boundaries', async () => {
    const access = vi.fn();
    await expect(
      managedPreflight(
        { root: () => 'unused', platform: 'freebsd', arch: 'x64', access },
        DEFAULT_MANAGED_INSTALL_POLICY,
      ),
    ).rejects.toMatchObject({ context: { code: 'unsupported-platform' } });
    expect(access).not.toHaveBeenCalled();
  });

  it('resolves archive tools through PATH and reports the exact executable path', async () => {
    const target = await root();
    const searched: string[] = [];
    const access = vi.fn(async (path: string, mode?: number) => {
      searched.push(path);
      if ((mode === constants.X_OK && path.endsWith('unzip')) || path === target) return;
      throw new Error('unavailable');
    });
    const result = await managedPreflight(
      {
        root: () => target,
        platform: 'linux',
        arch: 'x64',
        env: { PATH: join(target, 'bin') },
        access: access as never,
        statfs: enoughSpace,
      },
      DEFAULT_MANAGED_INSTALL_POLICY,
    );
    expect(result.archiveTools).toEqual([join(target, 'bin', 'unzip')]);
    expect(searched).toContain(join(target, 'bin', 'unzip'));
  });

  it('names every searched path when no executable archive tool exists', async () => {
    const target = await root();
    const env = { PATH: join(target, 'one') };
    await expect(
      managedPreflight(
        {
          root: () => target,
          platform: 'linux',
          arch: 'x64',
          env,
          access: vi.fn().mockRejectedValue(new Error('missing')) as never,
        },
        DEFAULT_MANAGED_INSTALL_POLICY,
      ),
    ).rejects.toMatchObject({
      context: { code: 'archive-tool-missing', searchedPaths: archiveToolPaths('linux', env) },
    });
  });

  it('fails closed when a configured proxy cannot be honored and strips credentials', async () => {
    const target = await root();
    await expect(
      managedPreflight(
        {
          root: () => target,
          platform: 'linux',
          arch: 'x64',
          env: { PATH: join(target, 'bin'), HTTPS_PROXY: 'http://user:secret@proxy.local:8080' },
          access: vi.fn().mockResolvedValue(undefined) as never,
          statfs: enoughSpace,
          nodeSupportsEnvProxy: false,
        },
        DEFAULT_MANAGED_INSTALL_POLICY,
      ),
    ).rejects.toMatchObject({
      context: { code: 'proxy-unsupported-runtime', proxyHost: 'proxy.local:8080' },
    });
  });

  it('refuses insufficient space and calls statfs exactly once', async () => {
    const target = await root();
    const statfs = vi.fn(async () => ({ bavail: 1, bsize: 1 })) as never;
    await expect(
      managedPreflight(
        {
          root: () => target,
          platform: 'linux',
          arch: 'x64',
          env: { PATH: join(target, 'bin') },
          access: vi.fn().mockResolvedValue(undefined) as never,
          statfs,
        },
        DEFAULT_MANAGED_INSTALL_POLICY,
      ),
    ).rejects.toMatchObject({ context: { code: 'insufficient-disk-space' } });
    expect(statfs).toHaveBeenCalledOnce();
  });

  it('maps a failed filesystem inspection instead of silently proceeding', async () => {
    const target = await root();
    await expect(
      managedPreflight(
        {
          root: () => target,
          platform: 'linux',
          arch: 'x64',
          env: { PATH: join(target, 'bin') },
          access: vi.fn().mockResolvedValue(undefined) as never,
          statfs: vi.fn().mockRejectedValue(new Error('volume offline')) as never,
        },
        DEFAULT_MANAGED_INSTALL_POLICY,
      ),
    ).rejects.toMatchObject({
      context: {
        code: 'insufficient-permissions',
        detail: expect.stringContaining('volume offline'),
      },
    });
  });

  it('strips proxy credentials before rendering malformed or valid URLs', () => {
    expect(stripProxyCredentials('http://user:secret@proxy.local:8080')).not.toContain('secret');
    expect(stripProxyCredentials('//user:secret@proxy.local')).toBe('//proxy.local');
  });
});
