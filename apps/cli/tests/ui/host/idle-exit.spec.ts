// @no-llm
/**
 * Idle exit (FEAT-065 TASK-018): ten quiet minutes end the host; running
 * workers never block it and are never touched.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@yantra/core';
import type { ProcessLivenessProbe } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { startHostRuntime } from '../../../src/ui/host/host-runtime.js';
import { IDLE_EXIT_MS, IdleExit } from '../../../src/ui/host/idle-exit.js';

import { cleanupTempDirs, makeWebBuild } from './support.js';

class SteppedTimers {
  public now = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  private next = 1;
  public setTimeout(callback: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.set(id, { at: this.now + ms, callback });
    return id;
  }
  public clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  public advance(ms: number): void {
    this.now += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }
}

function setup(state: { windows: number; pending: boolean }) {
  const timers = new SteppedTimers();
  const onIdle = vi.fn();
  const idle = new IdleExit({
    signals: {
      connectedWindows: () => state.windows,
      pendingStarts: () => Promise.resolve(state.pending),
    },
    onIdle,
    timers,
  });
  return { idle, onIdle, timers };
}

describe('IdleExit', () => {
  it('fires at exactly 10 minutes with only running invocations and no window', async () => {
    const env = setup({ windows: 0, pending: false });
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS - 1);
    expect(env.onIdle).not.toHaveBeenCalled();
    env.timers.advance(1);
    expect(env.onIdle).toHaveBeenCalledTimes(1);
  });

  it('does not start while an invocation is queued', async () => {
    const env = setup({ windows: 0, pending: true });
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS * 3);
    expect(env.onIdle).not.toHaveBeenCalled();
    expect(env.idle.counting).toBe(false);
  });

  it('does not start while a window is connected', async () => {
    const env = setup({ windows: 1, pending: false });
    await env.idle.check();
    expect(env.idle.counting).toBe(false);
  });

  it('is cancelled by a reconnect during the idle period', async () => {
    const state = { windows: 0, pending: false };
    const env = setup(state);
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS - 1_000);
    state.windows = 1;
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS);
    expect(env.onIdle).not.toHaveBeenCalled();
  });

  it('is cancelled by a new invocation, and restarts from zero afterwards', async () => {
    const state = { windows: 0, pending: false };
    const env = setup(state);
    await env.idle.check();
    env.timers.advance(5 * 60_000);
    state.pending = true;
    await env.idle.check();
    state.pending = false;
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS - 1);
    expect(env.onIdle).not.toHaveBeenCalled();
    env.timers.advance(1);
    expect(env.onIdle).toHaveBeenCalledTimes(1);
  });

  it('fires once', async () => {
    const env = setup({ windows: 0, pending: false });
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS);
    await env.idle.check();
    env.timers.advance(IDLE_EXIT_MS);
    expect(env.onIdle).toHaveBeenCalledTimes(1);
  });
});

describe('idle shutdown of a real host', () => {
  it('stops the host without signalling a running worker', async () => {
    const previous = process.env.YANTRA_HOME;
    const home = mkdtempSync(join(tmpdir(), 'yantra-idle-'));
    process.env.YANTRA_HOME = home;
    core.resetPathCache();
    const alive: ProcessLivenessProbe = {
      identify: (pid) => Promise.resolve({ pid, startToken: 't' }),
      check: () => Promise.resolve('alive'),
    };
    try {
      // Arrange: a running invocation whose worker is alive.
      const store = new core.FileInvocationStore();
      const id = '01JD2X7Q8R9S0T1V2W3X000001';
      const cwd = process.platform === 'win32' ? 'C:\\work' : '/work';
      await store.create({
        schema_version: 1,
        invocation_id: id,
        invocation: { invocation_id: id, path: ['research'], argv: ['q'], cwd },
        execution_class: 'run',
        state: 'queued',
        queued_at: '2026-11-11T10:00:00.000Z',
        updated_at: '2026-11-11T10:00:00.000Z',
        displayed_effective: { settings: [], content: [] },
        run_id: null,
        worker: null,
        review: null,
        result: null,
      });
      await store.reserve(id, () => null);
      await store.claim(id, { pid: 424_242, startToken: 'worker' });
      await store.markRunning(id, 'run-1');
      const kill = vi.spyOn(process, 'kill');
      let stopped: Promise<void> | null = null;
      const host = await startHostRuntime({
        assetsRoot: makeWebBuild(),
        identity: { pid: 990_001, startToken: 'h' },
        yantraVersion: '1',
        lock: new core.FileHostLock({ liveness: alive }),
        probe: alive,
        idleMs: 50,
        onIdle: () => {
          stopped = host.stop();
        },
      });

      // Act: nothing connects; the idle period passes.
      await vi.waitFor(() => {
        expect(stopped).not.toBeNull();
      });
      await stopped;

      // Assert
      expect(kill).not.toHaveBeenCalled();
      expect((await store.get(id))?.state).toBe('running');
      kill.mockRestore();
      cleanupTempDirs();
    } finally {
      if (previous === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = previous;
      core.resetPathCache();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
