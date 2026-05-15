import type { ChildProcess } from 'node:child_process';

import type { Browser } from 'puppeteer-core';
import puppeteer from 'puppeteer-core';

import { BrowserLaunchError } from './errors.js';
import { HARDENED_BASE_ARGS } from './launch-options.js';
import type { ChromeInstall, LaunchOptions, ResolvedProfile } from './types.js';

/** @internal Exported for snapshot testing only */
export function buildLaunchArgs(opts: LaunchOptions): readonly string[] {
  const args: string[] = [...HARDENED_BASE_ARGS];

  if (opts.viewport) {
    args.push(`--window-size=${opts.viewport.width},${opts.viewport.height}`);
  }

  args.push(...opts.extraArgs);
  return args;
}

/**
 * Launches Chrome over CDP pipe transport.
 * Uses puppeteer-core's built-in pipe support (--remote-debugging-pipe).
 *
 * @param opts - Validated launch options
 * @param chrome - Discovered Chrome installation
 * @param profile - Resolved profile directory
 * @returns Browser handle and spawned child process
 * @throws {BrowserLaunchError} on launch failure or startup timeout
 */
export async function launchChrome(
  opts: LaunchOptions,
  chrome: ChromeInstall,
  profile: ResolvedProfile,
): Promise<{ browser: Browser; child: ChildProcess }> {
  const args = buildLaunchArgs(opts);

  const launchPromise = puppeteer
    .launch({
      executablePath: chrome.path,
      args: [...args],
      pipe: true,
      headless: opts.headless,
      userDataDir: profile.absolutePath,
      env: { ...process.env, ...opts.env },
      dumpio: false,
      defaultViewport: opts.viewport,
    })
    .catch((cause: unknown) => {
      const msg = cause instanceof Error ? cause.message : String(cause);
      throw new BrowserLaunchError({
        phase: 'connect',
        lastStderr: msg,
        args: ['<redacted>'],
      });
    });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(
        new BrowserLaunchError({
          phase: 'timeout',
          lastStderr: `Startup did not complete within ${opts.startupTimeoutMs}ms`,
          args: ['<redacted>'],
        }),
      );
    }, opts.startupTimeoutMs);
    // Allow Node to exit even if timer fires
    if (typeof timer.unref === 'function') timer.unref();
  });

  const browser = await Promise.race([launchPromise, timeoutPromise]);

  const child = browser.process();
  if (!child) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await browser.close().catch(() => {});
    throw new BrowserLaunchError({
      phase: 'connect',
      lastStderr: 'Could not obtain child process handle from puppeteer',
      args: ['<redacted>'],
    });
  }

  return { browser, child };
}
