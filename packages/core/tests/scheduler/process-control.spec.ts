import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { LivenessVerdict } from '../../src/browser/installation-types.js';
import { FileDaemonLock } from '../../src/scheduler/daemon-lock.js';
import { NodeDaemonProcessControl } from '../../src/scheduler/process-control.js';

describe('@no-llm daemon process creation identity', () => {
  it.each(['dead', 'unknown'] as const)(
    'never signals a recorded owner whose liveness is %s',
    async (verdict) => {
      const signal = vi.fn();
      const control = new NodeDaemonProcessControl({
        entrypoint: '/fixture/bin.js',
        cwd: '/fixture',
        env: {},
        signal,
        liveness: { identify: () => Promise.resolve(null), check: () => Promise.resolve(verdict) },
      });
      await expect(
        control.signalDaemon({ pid: 17, identity: { pid: 17, startToken: 'original' } }),
      ).rejects.toThrow('creation identity');
      expect(signal).not.toHaveBeenCalled();
    },
  );
  it('refuses a legacy bare PID and signals only a verified matching identity', async () => {
    const signal = vi.fn();
    const check = vi.fn(() => Promise.resolve('alive' as LivenessVerdict));
    const control = new NodeDaemonProcessControl({
      entrypoint: '/fixture/bin.js',
      cwd: '/fixture',
      env: {},
      signal,
      liveness: { identify: () => Promise.resolve(null), check },
    });
    await expect(control.signalDaemon({ pid: 17 })).rejects.toThrow('creation identity');
    expect(check).not.toHaveBeenCalled();
    const identity = { pid: 17, startToken: 'original' };
    await control.signalDaemon({ pid: 17, identity });
    expect(check).toHaveBeenCalledWith(identity);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(17, 'SIGTERM');
  });
  it('records the identity with the daemon lock and removes it on release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-daemon-owner-'));
    const pidFile = join(root, 'daemon.pid');
    const identity = { pid: 17, startToken: 'fixture-start' };
    const lock = new FileDaemonLock({
      lockTarget: join(root, 'target'),
      pidFile,
      liveness: {
        identify: () => Promise.resolve(identity),
        check: () => Promise.resolve('alive'),
      },
    });
    const release = await lock.acquire(17);
    try {
      expect(await lock.probe()).toEqual({ pid: 17, identity });
      expect(JSON.parse(await readFile(`${pidFile}.identity.json`, 'utf8'))).toEqual(identity);
    } finally {
      await release();
      expect(await lock.probe()).toBeNull();
      await rm(root, { recursive: true, force: true });
    }
  });
});
