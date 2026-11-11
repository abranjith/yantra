// @no-llm
/**
 * Stale-asset reloads (FEAT-065 TASK-011, D17): only on a build mismatch, only
 * when idle, through a fresh window-bound code.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaleAssetWatcher, isTyping, pageBuildId } from '../../src/host/stale-assets.js';
import { ManualTimers, flush } from '../support/fake-socket.js';

function watcher(state: { pending: number; typing: boolean }) {
  const reloads: string[] = [];
  const timers = new ManualTimers();
  const request = vi.fn((_method: string) => Promise.resolve({ code: 'FRESH' }));
  const rpc = {
    get pendingCount() {
      return state.pending;
    },
    request: <T>(method: string): Promise<T> => request(method) as Promise<T>,
  };
  const subject = new StaleAssetWatcher({
    pageBuildId: 'page-build',
    rpc,
    isTyping: () => state.typing,
    reload: (code) => reloads.push(code),
    timers,
  });
  return { subject, reloads, timers, request };
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('StaleAssetWatcher', () => {
  it('does nothing when the builds match', async () => {
    const env = watcher({ pending: 0, typing: false });
    env.subject.check('page-build');
    await flush();
    expect(env.request).not.toHaveBeenCalled();
    expect(env.reloads).toEqual([]);
  });

  it('reloads at once with a fresh window-bound code when idle', async () => {
    const env = watcher({ pending: 0, typing: false });
    env.subject.check('host-build');
    await flush();
    expect(env.request).toHaveBeenCalledWith('session.launch_code');
    expect(env.reloads).toEqual(['FRESH']);
  });

  it('waits while a request is in flight, then reloads', async () => {
    const state = { pending: 1, typing: false };
    const env = watcher(state);
    env.subject.check('host-build');
    await flush();
    expect(env.reloads).toEqual([]);
    expect(env.subject.stale).toBe(true);
    env.timers.fire();
    await flush();
    expect(env.reloads).toEqual([]);
    state.pending = 0;
    env.timers.fire();
    await flush();
    expect(env.reloads).toEqual(['FRESH']);
  });

  it('waits while the user is typing', async () => {
    const state = { pending: 0, typing: true };
    const env = watcher(state);
    env.subject.check('host-build');
    await flush();
    expect(env.reloads).toEqual([]);
    state.typing = false;
    env.timers.fire();
    await flush();
    expect(env.reloads).toEqual(['FRESH']);
  });

  it('reloads once however many build notices arrive', () => {
    const env = watcher({ pending: 1, typing: false });
    env.subject.check('host-build');
    env.subject.check('host-build');
    env.subject.check('host-build');
    expect(env.timers.scheduled).toHaveLength(1);
  });
});

describe('page helpers', () => {
  it('reads the build ID from the meta tag, defaulting to dev', () => {
    expect(pageBuildId(document)).toBe('dev');
    document.head.innerHTML = '<meta name="yantra-build-id" content="abc">';
    expect(pageBuildId(document)).toBe('abc');
  });

  it('detects a focused text input but not a button', () => {
    document.body.innerHTML =
      '<input id="t" type="text"><button id="b">x</button><div id="e" contenteditable="true"></div>';
    document.getElementById('b')?.focus();
    expect(isTyping(document)).toBe(false);
    document.getElementById('t')?.focus();
    expect(isTyping(document)).toBe(true);
  });
});
