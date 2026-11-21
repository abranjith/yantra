/**
 * Opens the Yantra app in a Chrome or Edge `--app` window (FEAT-065 TASK-006,
 * plan D10, §7).
 *
 * The browser is the first of: system Google Chrome (never Chrome for
 * Testing), Microsoft Edge, then the resolved Yantra browser. It starts
 * detached, shell-free and unref'd, with its own `--user-data-dir` under the
 * data directory, and never with `--remote-debugging-*`, `--enable-automation`
 * or an automation profile: the app window is the user's, not a run's.
 *
 * The launch code never appears in the browser's command line, which other
 * local users can read on Linux and macOS (REV-004, D18). The window opens a
 * one-shot bootstrap page, written owner-only (`0600` in a `0700` directory),
 * that redirects to the host URL carrying the code in its fragment. Pages
 * older than the code's lifetime are removed on every launch, and each page
 * is removed again once its code has expired.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LocalBrowserResolver,
  detectAppWindowBrowser,
  uiChromeProfilePath,
  uiWindowBootstrapRoot,
  type AppWindowBrowser,
} from '@yantra/core';

/** The exact remediation when no Chromium browser exists (D10). */
export const NO_BROWSER_REMEDIATION =
  'Run `yantra browser install`, or open the URL above in Chrome or Edge.';

/** Arguments of an app window, in order. */
export function appWindowArgs(url: string, profileDir: string): string[] {
  return [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** What opening the window did. */
export type WindowOpenResult =
  | { readonly opened: true; readonly browser: string; readonly path: string }
  | { readonly opened: false; readonly message: string; readonly remediation: string };

export interface WindowLauncherDeps {
  readonly discover?: () => AppWindowBrowser | null;
  /** The Yantra browser, last resort; null when none resolves. */
  readonly yantraBrowser?: () => Promise<string | null>;
  readonly spawn?: typeof nodeSpawn;
  readonly profileDir?: () => string;
  /** Where bootstrap pages are written (default `<data-dir>/ui/window`). */
  readonly bootstrapDir?: () => string;
  readonly now?: () => number;
}

/** A bootstrap page outlives its launch code (60 s) by this much at most. */
export const BOOTSTRAP_MAX_AGE_MS = 120_000;

const BOOTSTRAP_PREFIX = 'launch-';

/** The bootstrap page for `url`: an immediate redirect, nothing else. */
export function bootstrapHtml(url: string): string {
  const attribute = url
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const script = JSON.stringify(url).replaceAll('<', '\\u003c');
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<title>Yantra</title>',
    `<meta http-equiv="refresh" content="0;url=${attribute}">`,
    `<script>location.replace(${script});</script>`,
    '',
  ].join('\n');
}

/** Removes bootstrap pages older than {@link BOOTSTRAP_MAX_AGE_MS}; best effort. */
export async function removeStaleBootstraps(dir: string, now: number = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(BOOTSTRAP_PREFIX) || !name.endsWith('.html')) continue;
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs > BOOTSTRAP_MAX_AGE_MS) await rm(path, { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/** Writes an owner-only bootstrap page for `url` and returns its path. */
export async function writeBootstrap(url: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const path = join(dir, `${BOOTSTRAP_PREFIX}${randomBytes(16).toString('hex')}.html`);
  await writeFile(path, bootstrapHtml(url), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

async function resolveYantraBrowser(): Promise<string | null> {
  const resolution = await new LocalBrowserResolver().resolve();
  return resolution.status === 'resolved' ? resolution.installation.canonicalPath : null;
}

/** Opens `url` as an app window; never throws for a missing browser. */
export async function openAppWindow(
  url: string,
  deps: WindowLauncherDeps = {},
): Promise<WindowOpenResult> {
  const found = (deps.discover ?? detectAppWindowBrowser)();
  let browser: { readonly path: string; readonly name: string } | null = found;
  if (browser === null) {
    const path = await (deps.yantraBrowser ?? resolveYantraBrowser)().catch(() => null);
    browser = path === null ? null : { path, name: 'the Yantra browser' };
  }
  if (browser === null) {
    return {
      opened: false,
      message: 'No Chrome, Edge or Yantra browser was found to open the app.',
      remediation: NO_BROWSER_REMEDIATION,
    };
  }
  const bootstrapDir = (deps.bootstrapDir ?? uiWindowBootstrapRoot)();
  await removeStaleBootstraps(bootstrapDir, (deps.now ?? Date.now)());
  let bootstrap: string;
  try {
    bootstrap = await writeBootstrap(url, bootstrapDir);
  } catch (error) {
    return {
      opened: false,
      message: `The app window could not be prepared: ${error instanceof Error ? error.message : String(error)}.`,
      remediation: NO_BROWSER_REMEDIATION,
    };
  }
  // Removed once the code it carries has expired; unref'd, so a short-lived
  // `yantra ui` does not wait for it (the next launch sweeps it instead).
  setTimeout(() => {
    void rm(bootstrap, { force: true });
  }, BOOTSTRAP_MAX_AGE_MS).unref();
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(
    browser.path,
    appWindowArgs(pathToFileURL(bootstrap).href, (deps.profileDir ?? uiChromeProfilePath)()),
    {
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: false,
    },
  );
  const started = await new Promise<Error | null>((resolve) => {
    child.once('spawn', () => {
      resolve(null);
    });
    child.once('error', (error) => {
      resolve(error);
    });
  });
  child.on('error', () => undefined);
  child.unref();
  if (started !== null) {
    return {
      opened: false,
      message: `${browser.name} could not be started: ${started.message}.`,
      remediation: NO_BROWSER_REMEDIATION,
    };
  }
  return { opened: true, browser: browser.name, path: browser.path };
}
