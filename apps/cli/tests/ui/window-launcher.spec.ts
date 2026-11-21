// @no-llm
/**
 * The app window launcher (FEAT-065 TASK-006): browser order, the exact
 * argument list, detached shell-free spawn, and the no-Chromium result; the
 * launch code reaches the window through an owner-only bootstrap page, never
 * through argv (REV-004).
 */

import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resetPathCache, uiChromeProfilePath, uiWindowBootstrapRoot } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOOTSTRAP_MAX_AGE_MS,
  NO_BROWSER_REMEDIATION,
  appWindowArgs,
  bootstrapHtml,
  openAppWindow,
  removeStaleBootstraps,
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
      expect.stringMatching(/^--app=file:\/\/.*launch-[0-9a-f]{32}\.html$/u),
      `--user-data-dir=${uiChromeProfilePath()}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]);
    expect(uiChromeProfilePath()).toBe(join(home, 'data', 'ui', 'chrome-profile'));
  });

  it('never puts the launch code in the command line (REV-004)', async () => {
    const calls: SpawnCall[] = [];
    await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/chrome', name: 'Google Chrome' }),
      spawn: fakeSpawn(calls),
    });
    const argv = calls[0]!.args.join(' ');
    expect(argv).not.toContain('code=');
    expect(argv).not.toContain('abc');
    expect(argv).not.toContain('127.0.0.1');
  });

  it('opens an owner-only bootstrap page that redirects to the host URL', async () => {
    const calls: SpawnCall[] = [];
    await openAppWindow(URL, {
      discover: () => ({ kind: 'chrome', path: '/chrome', name: 'Google Chrome' }),
      spawn: fakeSpawn(calls),
    });
    const page = fileURLToPath(calls[0]!.args[0]!.slice('--app='.length));
    expect(page.startsWith(uiWindowBootstrapRoot())).toBe(true);
    expect(uiWindowBootstrapRoot()).toBe(join(home, 'data', 'ui', 'window'));
    expect(readFileSync(page, 'utf8')).toBe(bootstrapHtml(URL));
    if (process.platform !== 'win32') {
      expect(statSync(page).mode & 0o777).toBe(0o600);
      expect(statSync(uiWindowBootstrapRoot()).mode & 0o777).toBe(0o700);
    }
  });

  it('writes no bootstrap page when no browser opens', async () => {
    await openAppWindow(URL, {
      discover: () => null,
      yantraBrowser: () => Promise.resolve(null),
      spawn: fakeSpawn([]),
    });
    expect(() => readdirSync(uiWindowBootstrapRoot())).toThrow();
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

describe('bootstrap pages (REV-004)', () => {
  it('redirect by meta refresh and script, escaped for both', () => {
    const html = bootstrapHtml('http://127.0.0.1:1/#code=a&b"<x>');
    expect(html).toContain('content="0;url=http://127.0.0.1:1/#code=a&amp;b&quot;&lt;x&gt;"');
    expect(html).toContain('location.replace("http://127.0.0.1:1/#code=a&b\\"\\u003cx>")');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toMatch(/<script>[^<]*<x>/u);
  });

  it('are swept once older than the code lifetime, leaving fresh and foreign files', () => {
    const dir = join(home, 'sweep');
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    for (const name of ['launch-old.html', 'launch-fresh.html', 'other.html']) {
      writeFileSync(join(dir, name), 'x');
    }
    const old = (now - BOOTSTRAP_MAX_AGE_MS - 1_000) / 1000;
    utimesSync(join(dir, 'launch-old.html'), old, old);
    utimesSync(join(dir, 'other.html'), old, old);

    return removeStaleBootstraps(dir, now).then(() => {
      expect(readdirSync(dir).sort()).toEqual(['launch-fresh.html', 'other.html']);
    });
  });

  it('sweeping a missing directory does nothing', async () => {
    await expect(removeStaleBootstraps(join(home, 'nope'))).resolves.toBeUndefined();
  });
});
