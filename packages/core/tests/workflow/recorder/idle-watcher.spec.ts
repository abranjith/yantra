/**
 * TASK-012: Idle watcher tests.
 *
 * Uses vitest fake timers to avoid actual waiting.
 * Tagged @no-llm — must pass with LLM_PROVIDER=none.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IdleWatcher } from '../../../src/workflow/recorder/idle-watcher.js';

describe('@no-llm IdleWatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onIdleTimeout after the configured threshold', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(1000);

    vi.advanceTimersByTime(999);
    expect(onIdleTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onIdleTimeout).toHaveBeenCalledOnce();

    watcher.stop();
  });

  it('does not fire when stop() is called before threshold', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(1000);

    vi.advanceTimersByTime(500);
    watcher.stop();
    vi.advanceTimersByTime(1000);

    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it('resets the timer when ping() is called', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(1000);

    vi.advanceTimersByTime(800);
    watcher.ping(); // reset

    vi.advanceTimersByTime(800);
    expect(onIdleTimeout).not.toHaveBeenCalled(); // not yet — timer was reset

    vi.advanceTimersByTime(200);
    expect(onIdleTimeout).toHaveBeenCalledOnce();

    watcher.stop();
  });

  it('fires exactly once per idle period (not repeatedly)', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(100);

    vi.advanceTimersByTime(500); // well past threshold
    expect(onIdleTimeout).toHaveBeenCalledOnce();

    watcher.stop();
  });

  it('can be re-armed via ping() after firing', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(100);

    vi.advanceTimersByTime(200);
    expect(onIdleTimeout).toHaveBeenCalledOnce();

    // Ping to re-arm
    watcher.ping();
    vi.advanceTimersByTime(200);
    expect(onIdleTimeout).toHaveBeenCalledTimes(2);

    watcher.stop();
  });

  it('stop() is idempotent — safe to call multiple times', () => {
    const onIdleTimeout = vi.fn();
    const watcher = new IdleWatcher({ onIdleTimeout });
    watcher.start(100);
    watcher.stop();
    watcher.stop(); // should not throw
    watcher.stop();

    expect(onIdleTimeout).not.toHaveBeenCalled();
  });

  it('emits exactly one IdleTimeoutPromptEvent per idle period', () => {
    const events: string[] = [];
    const watcher = new IdleWatcher({
      onIdleTimeout: () => events.push('prompt'),
    });
    watcher.start(100);

    vi.advanceTimersByTime(100);
    expect(events).toEqual(['prompt']);

    vi.advanceTimersByTime(500); // timer is spent — no second event
    expect(events).toEqual(['prompt']);

    watcher.stop();
  });
});
