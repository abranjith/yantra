// @no-llm
/**
 * The app window launcher (FEAT-065 TASK-006): browser order, the exact
 * argument list, detached shell-free spawn, and the no-Chromium result.
 */

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetPathCache, uiChromeProfilePath } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NO_BROWSER_REMEDIATION,
  appWindowArgs,
  openAppWindow,
} from '../../src/ui/window-launcher.js';

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

/** A spawn double that emits `spawn` (or `error`) on the next tick. */
function fakeSpawn(calls: SpawnCall[], fail?: Error): typeof spawn {
  return ((file: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    const child = new EventEmitter() as EventEmitter & { unref: () => void; unrefed: boolean };
    child.unrefed = false;
    child.unref = () => {
      child.unrefed = true;
    };
    setImmediate(() => {
      if (fail === undefined) child.emit('spawn');
      else child.emit('error', fail);
    });
    return child;
  }) as unknown as typeof spawn;
}

const URL = 'http://127.0.0.1:5000/#code=abc';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-window-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

describe('browser order', () => {
  it('uses the discovered Chrome before the Yantra browser', async () => {
    const calls: SpawnCall[] = [];
    let yantraAsked = false;
    const result = await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/chrome', name: 'Google Chrome' }),
      yantraBrowser: () => {
        yantraAsked = true;
        return Promise.resolve('/yantra-chrome');
      },
      spawn: fakeSpawn(calls),
    });
    expect(result).toEqual({ opened: true, browser: 'Google Chrome', path: '/chrome' });
    expect(calls[0]?.file).toBe('/chrome');
    expect(yantraAsked).toBe(false);
  });

  it('uses Edge when discovery returns it', async () => {
    const calls: SpawnCall[] = [];
    const result = await openAppWindow(URL, {
      discover: () => ({ kind: 'edge', path: '/edge', name: 'Microsoft Edge' }),
      spawn: fakeSpawn(calls),
    });
    expect(result).toMatchObject({ opened: true, browser: 'Microsoft Edge' });
  });

  it('falls back to the Yantra browser last', async () => {
    const calls: SpawnCall[] = [];
    const result = await openAppWindow(URL, {
      discover: () => null,
      yantraBrowser: () => Promise.resolve('/managed/chrome'),
      spawn: fakeSpawn(calls),
    });
    expect(result).toEqual({
      opened: true,
      browser: 'the Yantra browser',
      path: '/managed/chrome',
    });
  });
});

describe('the spawned window', () => {
  it('gets exactly the app arguments, with the data-directory profile', async () => {
    const calls: SpawnCall[] = [];
    await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/chrome', name: 'Google Chrome' }),
      spawn: fakeSpawn(calls),
    });
    expect(calls[0]?.args).toEqual([
      `--app=${URL}`,
      `--user-data-dir=${uiChromeProfilePath()}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    expect(uiChromeProfilePath()).toBe(join(home, 'data', 'ui', 'chrome-profile'));
  });

  it('never passes a remote-debugging or automation flag', () => {
    const args = appWindowArgs(URL, '/profile').join(' ');
    expect(args).not.toMatch(/remote-debugging|enable-automation|headless|test-type/u);
  });

  it('is detached, shell-free and stdio-free', async () => {
    const calls: SpawnCall[] = [];
    await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/chrome', name: 'Google Chrome' }),
      spawn: fakeSpawn(calls),
    });
    expect(calls[0]?.options).toMatchObject({ detached: true, shell: false, stdio: 'ignore' });
  });
});

describe('no Chromium', () => {
  it('reports the exact remediation and spawns nothing', async () => {
    const calls: SpawnCall[] = [];
    const result = await openAppWindow(URL, {
      discover: () => null,
      yantraBrowser: () => Promise.resolve(null),
      spawn: fakeSpawn(calls),
    });
    expect(result).toEqual({
      opened: false,
      message: 'No Chrome, Edge or Yantra browser was found to open the app.',
      remediation: 'Run `yantra browser install`, or open the URL above in Chrome or Edge.',
    });
    expect(NO_BROWSER_REMEDIATION).toContain('yantra browser install');
    expect(calls).toEqual([]);
  });

  it('treats a failing Yantra browser resolution as none', async () => {
    const result = await openAppWindow(URL, {
      discover: () => null,
      yantraBrowser: () => Promise.reject(new Error('broken config')),
      spawn: fakeSpawn([]),
    });
    expect(result.opened).toBe(false);
  });

  it('reports a browser that fails to start instead of claiming it opened', async () => {
    const result = await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/gone', name: 'Google Chrome' }),
      spawn: fakeSpawn([], Object.assign(new Error('spawn /gone ENOENT'), { code: 'ENOENT' })),
    });
    expect(result).toMatchObject({ opened: false, remediation: NO_BROWSER_REMEDIATION });
    expect(result.opened === false && result.message).toContain('ENOENT');
  });
});
