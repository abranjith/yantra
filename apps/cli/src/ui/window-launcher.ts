/**
 * Opens the Yantra app in a Chrome or Edge `--app` window (FEAT-065 TASK-006,
 * plan D10, §7).
 *
 * The browser is the first of: system Google Chrome (never Chrome for
 * Testing), Microsoft Edge, then the resolved Yantra browser. It starts
 * detached, shell-free and unref'd, with its own `--user-data-dir` under the
 * data directory, and never with `--remote-debugging-*`, `--enable-automation`
 * or an automation profile: the app window is the user's, not a run's.
 */

import { spawn as nodeSpawn } from 'node:child_process';

import {
  LocalBrowserResolver,
  detectAppWindowBrowser,
  uiChromeProfilePath,
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
  const spawn = deps.spawn ?? nodeSpawn;
  const child = spawn(
    browser.path,
    appWindowArgs(url, (deps.profileDir ?? uiChromeProfilePath)()),
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
