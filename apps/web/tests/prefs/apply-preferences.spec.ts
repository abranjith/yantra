// @no-llm
/**
 * Applying `ui.theme` and `ui.surfaces` (FEAT-065 TASK-011).
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  appearanceFromProfile,
  startPreferences,
  type PreferencesRpc,
} from '../../src/prefs/apply-preferences.js';
import { flush } from '../support/fake-socket.js';

function profile(theme?: string, surfaces?: string) {
  const preferences = [
    { key: 'defaults.detail', value: 'standard' },
    ...(theme === undefined ? [] : [{ key: 'ui.theme', value: theme }]),
    ...(surfaces === undefined ? [] : [{ key: 'ui.surfaces', value: surfaces }]),
  ];
  return {
    schema: null,
    value: { schemaVersion: '0.2', kind: 'profile', preferences },
    next_cursor: null,
  };
}

class FakeRpc implements PreferencesRpc {
  public current: unknown = profile();
  public readonly subscribed: string[] = [];
  private readonly handlers = new Map<string, (params: Record<string, unknown>) => void>();
  public request<T>(method: string): Promise<T> {
    if (method !== 'read.profile') return Promise.reject(new Error(method));
    return Promise.resolve(this.current as T);
  }
  public subscribe(method: string): void {
    this.subscribed.push(method);
  }
  public on(method: string, handler: (params: Record<string, unknown>) => void): () => void {
    this.handlers.set(method, handler);
    return () => this.handlers.delete(method);
  }
  public emit(method: string): void {
    this.handlers.get(method)?.({});
  }
}

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement('html');
});

describe('appearanceFromProfile', () => {
  it.each([
    [profile('dark', 'solid'), { theme: 'dark', surfaces: 'solid' }],
    [profile('light'), { theme: 'light', surfaces: 'glass' }],
    [profile(), { theme: 'system', surfaces: 'glass' }],
    [profile('neon', 'frosted'), { theme: 'system', surfaces: 'glass' }],
    [null, { theme: 'system', surfaces: 'glass' }],
  ])('reads %j', (result, expected) => {
    expect(appearanceFromProfile(result)).toEqual(expected);
  });
});

describe('startPreferences', () => {
  it('sets data-theme and data-surfaces, omitting data-theme for system', async () => {
    const rpc = new FakeRpc();
    rpc.current = profile('dark', 'solid');
    startPreferences(rpc, root);
    await flush();
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.surfaces).toBe('solid');
    expect(rpc.subscribed).toEqual(['runs.subscribe']);
  });

  it('follows a live prefs.changed', async () => {
    // Arrange
    const rpc = new FakeRpc();
    rpc.current = profile('dark');
    startPreferences(rpc, root);
    await flush();

    // Act: the user switches back to system with solid surfaces.
    rpc.current = profile('system', 'solid');
    rpc.emit('prefs.changed');
    await flush();

    // Assert
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.dataset.surfaces).toBe('solid');
  });

  it('keeps the current look when the read fails', async () => {
    const rpc = new FakeRpc();
    rpc.current = profile('dark');
    startPreferences(rpc, root);
    await flush();
    rpc.request = () => Promise.reject(new Error('down'));
    rpc.emit('prefs.changed');
    await flush();
    expect(root.dataset.theme).toBe('dark');
  });
});
