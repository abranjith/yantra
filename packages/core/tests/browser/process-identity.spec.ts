import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NodeProcessLivenessProbe,
  UNKNOWN_START_TOKEN,
  currentProcessIdentity,
  identifyProcess,
  processExists,
  readStartToken,
  resetCurrentProcessIdentity,
} from '../../src/browser/process-identity.js';

/** A real child that lives until it is killed, for liveness assertions. */
function spawnSleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  return { child, exited };
}

describe('@no-llm process identity', () => {
  afterEach(() => {
    resetCurrentProcessIdentity();
  });

  it('identifies the current process', async () => {
    const identity = await currentProcessIdentity();

    expect(identity.pid).toBe(process.pid);
    expect(identity.startToken.length).toBeGreaterThan(0);
  });

  it('memoizes the current identity', async () => {
    const first = await currentProcessIdentity();
    const second = await currentProcessIdentity();

    expect(second).toBe(first);
  });

  it('returns null for a pid that does not exist', async () => {
    // 2^22 + 1 is above every default pid_max, so it cannot be a live process.
    await expect(readStartToken(4_194_305)).resolves.toBeNull();
    await expect(identifyProcess(4_194_305)).resolves.toBeNull();
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects the invalid pid %s', async (pid) => {
    await expect(readStartToken(pid)).resolves.toBeNull();
    expect(processExists(pid)).toBe(false);
  });

  it('reports a live child as alive and a dead one as dead', async () => {
    const probe = new NodeProcessLivenessProbe();
    const { child, exited } = spawnSleeper();
    try {
      const identity = await identifyProcess(child.pid!);
      expect(identity).not.toBeNull();

      await expect(probe.check(identity!)).resolves.toBe('alive');

      child.kill('SIGKILL');
      await exited;

      await expect(probe.check(identity!)).resolves.toBe('dead');
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });

  it('treats a reused pid as dead by comparing creation identity, never age', async () => {
    const probe = new NodeProcessLivenessProbe();
    const { child, exited } = spawnSleeper();
    try {
      const real = await identifyProcess(child.pid!);
      expect(real).not.toBeNull();

      // Same pid, different creation token — exactly what pid reuse looks like.
      const stale = { pid: real!.pid, startToken: `${real!.startToken}-stale` };

      await expect(probe.check(stale)).resolves.toBe('dead');
      await expect(probe.check(real!)).resolves.toBe('alive');
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('reports unknown when a creation token cannot be compared', async () => {
    const probe = new NodeProcessLivenessProbe();

    const verdict = await probe.check({ pid: process.pid, startToken: UNKNOWN_START_TOKEN });

    expect(verdict).toBe('unknown');
  });

  it('falls back to an existence test on an unrecognized platform', async () => {
    await expect(readStartToken(process.pid, 'aix')).resolves.toBe(UNKNOWN_START_TOKEN);
    await expect(readStartToken(4_194_305, 'aix')).resolves.toBeNull();
  });
});
