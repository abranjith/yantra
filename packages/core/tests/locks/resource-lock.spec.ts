import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  mutateConfig,
  mutateConfigDocument,
  setConfigKey,
  writeConfigDocument,
} from '../../src/config/write.js';
import { writeFileAtomic } from '../../src/fs/atomic-write.js';
import {
  acquireResourceLease,
  probeResourceLock,
  ResourceBusyError,
  resourceLockTarget,
  withResourceLock,
  type ResourceLease,
  type ResourceLockOptions,
} from '../../src/locks/resource-lock.js';

describe('@no-llm process-safe resource locks', () => {
  let root: string;
  let target: string;
  let options: ResourceLockOptions;
  const leases: ResourceLease[] = [];
  const owner = {
    pid: 1234,
    command: 'yantra config set',
    started_at: '2026-11-06T12:00:00.000Z',
    surface: 'terminal' as const,
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-resource-lock-'));
    target = join(root, 'config.yaml');
    options = { targetPath: target, retries: 0, owner, logger: { warn: vi.fn() } };
  });
  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    await rm(root, { recursive: true, force: true });
  });
  async function hold(): Promise<ResourceLease> {
    const lease = await acquireResourceLease({ kind: 'config' }, options);
    leases.push(lease);
    return lease;
  }

  it('describes the holder on contention and removes lock and owner on release', async () => {
    const lease = await hold();
    expect(await probeResourceLock({ kind: 'config' }, options)).toEqual(owner);
    await expect(acquireResourceLease({ kind: 'config' }, options)).rejects.toMatchObject({
      name: 'ResourceBusyError',
      resource: { kind: 'config' },
      holder: owner,
      remediation: 'Try again when it finishes.',
    });
    await Promise.all([lease.release(), lease.release()]);
    expect(await readdir(root)).toEqual([]);
    expect(await probeResourceLock({ kind: 'config' }, options)).toBeNull();
  });

  it('waits for a holder to release within the bounded retry window', async () => {
    const lease = await hold();
    const second = acquireResourceLease(
      { kind: 'config' },
      { ...options, retries: { retries: 10, minTimeout: 10, maxTimeout: 20 } },
    );
    const release = setTimeout(() => {
      void lease.release();
    }, 30);
    try {
      const acquired = await second;
      leases.push(acquired);
      expect(acquired.owner).toEqual(owner);
    } finally {
      clearTimeout(release);
    }
  });

  it('returns typed busy after bounded retries rather than running the mutation', async () => {
    await hold();
    const mutation = vi.fn();
    await expect(
      withResourceLock({ kind: 'config' }, mutation, {
        ...options,
        retries: { retries: 2, minTimeout: 10, maxTimeout: 10 },
      }),
    ).rejects.toBeInstanceOf(ResourceBusyError);
    expect(mutation).not.toHaveBeenCalled();
  });

  it('reclaims a stale orphan without interpreting the recorded PID as live', async () => {
    await mkdir(`${target}.lock`);
    await writeFile(
      `${target}.lock.owner.json`,
      JSON.stringify({ ...owner, command: 'dead writer' }),
    );
    const old = new Date(Date.now() - 30_000);
    await utimes(`${target}.lock`, old, old);
    await hold();
    expect(await probeResourceLock({ kind: 'config' }, options)).toEqual(owner);
  });

  it('keeps contention typed when the advisory owner record is damaged', async () => {
    await hold();
    await writeFile(`${target}.lock.owner.json`, 'malformed');
    await expect(acquireResourceLease({ kind: 'config' }, options)).rejects.toMatchObject({
      holder: null,
      name: 'ResourceBusyError',
    });
  });

  it('releases the lock when the protected operation throws', async () => {
    const failure = new Error('invalid operation');
    await expect(
      withResourceLock(
        { kind: 'config' },
        async () => {
          throw failure;
        },
        options,
      ),
    ).rejects.toBe(failure);
    await hold();
  });

  it('does not misclassify permission errors as busy', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const lock = vi.fn(async () => {
      throw failure;
    }) as unknown as typeof lockfile.lock;
    await expect(acquireResourceLease({ kind: 'config' }, { ...options, lock })).rejects.toBe(
      failure,
    );
  });

  it('logs compromise without a timer throw and never releases a successor lease', async () => {
    let compromised: ((error: Error) => void) | undefined;
    const release = vi.fn(async () => undefined);
    const lock = vi.fn(async (_path: string, opts?: lockfile.LockOptions) => {
      compromised = opts?.onCompromised;
      return release;
    }) as unknown as typeof lockfile.lock;
    const lease = await acquireResourceLease({ kind: 'config' }, { ...options, lock });
    const successor = { ...owner, pid: 5678 };
    await writeFile(`${target}.lock.owner.json`, JSON.stringify(successor));
    expect(() => compromised?.(new Error('heartbeat lost'))).not.toThrow();
    await lease.release();
    expect(release).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(`${target}.lock.owner.json`, 'utf8'))).toEqual(successor);
    expect(options.logger?.warn).toHaveBeenCalled();
  });

  it('rejects names that escape the workflow/template root and relative profile paths', () => {
    expect(() => resourceLockTarget({ kind: 'workflow', name: '../escape' })).toThrow();
    expect(() => resourceLockTarget({ kind: 'template', name: '../escape' })).toThrow();
    expect(() => resourceLockTarget({ kind: 'browser-profile', path: 'relative' })).toThrow();
  });

  it('does not trust an orphan sidecar when no lock directory exists', async () => {
    await writeFile(`${target}.lock.owner.json`, JSON.stringify(owner));
    expect(await probeResourceLock({ kind: 'config' }, options)).toBeNull();
  });

  it('reads the parsed config only after acquiring the lock', async () => {
    await writeConfigDocument('version: 1\nretention:\n  runs_days: 30\n', target);
    const lease = await hold();
    let onAttempt: (() => void) | undefined;
    const attempted = new Promise<void>((resolve) => {
      onAttempt = resolve;
    });
    const mutation = mutateConfig(
      (current) => {
        expect(current.retention.runs_days).toBe(60);
        return { ...current, retention: { ...current.retention, corrupt_index_keep: 4 } };
      },
      target,
      {
        ...options,
        retries: { retries: 20, minTimeout: 10, maxTimeout: 20 },
        lock: ((path: string, opts?: lockfile.LockOptions) => {
          onAttempt?.();
          return lockfile.lock(path, opts);
        }) as typeof lockfile.lock,
      },
    );
    await attempted;
    await writeFileAtomic(target, 'version: 1\nretention:\n  runs_days: 60\n');
    await lease.release();
    await mutation;
    const text = await readFile(target, 'utf8');
    expect(text).toContain('runs_days: 60');
    expect(text).toContain('corrupt_index_keep: 4');
  });

  it('releases config locks after malformed YAML and rejected candidates', async () => {
    await writeFile(target, 'browser: [unterminated');
    await expect(setConfigKey('browser.source', 'system', target)).rejects.toThrow('malformed');
    expect(await readFile(target, 'utf8')).toBe('browser: [unterminated');
    await writeConfigDocument('version: 1\n', target);
    await expect(setConfigKey('retention.runs_days', -1, target)).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('version: 1\n');
    await mutateConfigDocument((document) => {
      document.setIn(['browser', 'source'], 'system');
    }, target);
    expect(await readFile(target, 'utf8')).toContain('source: system');
  });

  it('preserves existing loader errors for parsed mutations', async () => {
    await writeFile(target, 'browser: [unterminated');
    await expect(mutateConfig((current) => current, target)).rejects.toMatchObject({
      name: 'ConfigError',
    });
    expect(await readFile(target, 'utf8')).toBe('browser: [unterminated');
    await writeConfigDocument('version: 1\n', target);
    await expect(
      mutateConfig(
        (current) => ({ ...current, retention: { ...current.retention, runs_days: -1 } }),
        target,
      ),
    ).rejects.toThrow();
    expect(await readFile(target, 'utf8')).toBe('version: 1\n');
  });

  it('captures the previous values before a mutator edits its input', async () => {
    await writeConfigDocument('# owner comment\nversion: 1\nretention:\n  runs_days: 30\n', target);
    await mutateConfig((current) => {
      current.retention.runs_days = 60;
      return current;
    }, target);
    const text = await readFile(target, 'utf8');
    expect(text).toContain('runs_days: 60');
    expect(text).toContain('# owner comment');
  });
});
