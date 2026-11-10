// @no-llm
/**
 * `config data-dir` refuses while a run or the app host is live (FEAT-064
 * TASK-013, D15), in a sandboxed YANTRA_HOME.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UNKNOWN_START_TOKEN,
  claimLease,
  currentProcessIdentity,
  dataDir,
  resetPathCache,
  runsRoot,
  uiHostLockPath,
  type ProcessIdentity,
} from '@yantra/core';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeConfigCommand } from '../../src/commands/config.js';

const SOCKET = { kind: 'pipe', address: `\\\\.\\pipe\\yantra-${'cd'.repeat(16)}` } as const;
const GONE: ProcessIdentity = { pid: 0x3ffffff0, startToken: 'test:gone' };

describe('@no-llm config data-dir guard', () => {
  let root: string;
  let target: string;
  let saved: Record<string, string | undefined>;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-data-dir-guard-'));
    target = join(root, 'elsewhere');
    saved = {
      YANTRA_HOME: process.env.YANTRA_HOME,
      YANTRA_DATA_DIR: process.env.YANTRA_DATA_DIR,
      YANTRA_CACHE_DIR: process.env.YANTRA_CACHE_DIR,
    };
    process.env.YANTRA_HOME = join(root, 'home');
    delete process.env.YANTRA_DATA_DIR;
    delete process.env.YANTRA_CACHE_DIR;
    resetPathCache();
    await mkdir(dataDir(), { recursive: true });
    await writeFile(join(dataDir(), 'marker.txt'), 'stay');
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  async function relocate(...extra: string[]): Promise<number> {
    try {
      await makeConfigCommand({ hasActiveManagedUse: () => Promise.resolve(false) })
        .exitOverride()
        .parseAsync(['data-dir', target, ...extra], { from: 'user' });
      return 0;
    } catch (error) {
      if (error instanceof CommanderError) return error.exitCode;
      throw error;
    }
  }

  async function leaseOwnedBy(runId: string, owner: ProcessIdentity): Promise<void> {
    const runDir = join(runsRoot(), runId);
    await mkdir(runDir, { recursive: true });
    await claimLease(
      runDir,
      {
        runId,
        origin: 'worker',
        executionClass: 'run',
        command: ['research'],
        socket: SOCKET,
        logSeqAtClaim: 0,
      },
      { identity: owner },
    );
  }

  function untouched(): void {
    expect(existsSync(join(dataDir(), 'marker.txt'))).toBe(true);
    expect(existsSync(target)).toBe(false);
  }

  it('refuses with exit 3 and the run ID while a run owner is alive, moving nothing', async () => {
    await leaseOwnedBy('20261109T120000Z-research-live0001', await currentProcessIdentity());
    expect(await relocate()).toBe(3);
    expect(stderr.join('')).toContain('run 20261109T120000Z-research-live0001');
    expect(stderr.join('')).toContain(`pid ${process.pid}`);
    untouched();
  }, 30_000);

  it('refuses while a run owner cannot be verified', async () => {
    await leaseOwnedBy('20261109T120000Z-research-unkn0001', {
      pid: process.pid,
      startToken: UNKNOWN_START_TOKEN,
    });
    expect(await relocate()).toBe(3);
    untouched();
  });

  it('reports the same refusal under --dry-run', async () => {
    await leaseOwnedBy('20261109T120000Z-research-live0002', await currentProcessIdentity());
    expect(await relocate('--dry-run')).toBe(3);
    expect(stderr.join('')).toContain('data relocation is unavailable while a run is live');
    untouched();
  }, 30_000);

  it('does not block on a run whose owner is dead', async () => {
    await leaseOwnedBy('20261109T120000Z-research-dead0001', GONE);
    expect(await relocate('--dry-run')).toBe(0);
  });

  it('refuses with the close-the-app steps while the app host is live', async () => {
    const own = await currentProcessIdentity();
    await mkdir(join(dataDir(), 'ui'), { recursive: true });
    await writeFile(
      uiHostLockPath(),
      JSON.stringify({ pid: own.pid, start_token: own.startToken, port: 1, extra: 'ignored' }),
    );
    expect(await relocate()).toBe(3);
    const message = stderr.join('');
    expect(message).toContain('close the app');
    expect(message).toContain('yantra config data-dir <path>');
    expect(message).toContain('yantra ui');
    untouched();
  }, 30_000);

  it('does not block on a dead host lock', async () => {
    await mkdir(join(dataDir(), 'ui'), { recursive: true });
    await writeFile(
      uiHostLockPath(),
      JSON.stringify({ pid: GONE.pid, start_token: GONE.startToken }),
    );
    expect(await relocate('--dry-run')).toBe(0);
  });

  it('warns about, but does not block on, a corrupt host lock', async () => {
    await mkdir(join(dataDir(), 'ui'), { recursive: true });
    await writeFile(uiHostLockPath(), '{ not json');
    expect(await relocate('--dry-run')).toBe(0);
    expect(stderr.join('')).toContain('the app host lock could not be read');
  });
});
