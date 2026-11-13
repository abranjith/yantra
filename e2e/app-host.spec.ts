/// <reference lib="dom" />
/**
 * @no-llm The Yantra app end to end (FEAT-065 TASK-013, M1).
 *
 * The built CLI starts a real host (`yantra ui --print`), real Chrome opens
 * the URL, and the page must connect without a single request leaving
 * `127.0.0.1:<port>`, without a CSP violation, with the launch code gone from
 * the address bar and with no axe-core violation. A reload resumes the same
 * window, and a hostile page on another loopback port gets nothing.
 *
 * Deliberately ungated: a missing Chrome fails with a remediation.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { UiOpenResult } from '@yantra/protocol';
import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchGalleryBrowser } from './drshya/browser.js';
import { runAxe } from './drshya/capture.js';

const BIN = resolve(import.meta.dirname, '..', 'apps', 'cli', 'dist', 'bin.js');
const TIMEOUT = 60_000;

declare global {
  interface Window {
    __yantraCsp?: { blockedURI: string; violatedDirective: string }[];
    __hostile?: { fetch: string; socket: string };
  }
}

let home: string;
let browser: Browser;
let opened: UiOpenResult;
let origin: string;

function openUrl(): UiOpenResult {
  return UiOpenResult.parse(
    JSON.parse(
      execFileSync(process.execPath, [BIN, 'ui', '--print', '--json'], {
        env: { ...process.env, YANTRA_HOME: home, LLM_PROVIDER: 'none', YANTRA_UI_ASSETS_DIR: '' },
        encoding: 'utf8',
      }),
    ),
  );
}

interface Watched {
  readonly page: Page;
  readonly requests: string[];
  readonly pageErrors: string[];
  csp(): Promise<{ blockedURI: string; violatedDirective: string }[]>;
}

async function watchedPage(): Promise<Watched> {
  const page = await browser.newPage();
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) =>
    pageErrors.push(error instanceof Error ? error.message : String(error)),
  );
  await page.evaluateOnNewDocument(() => {
    window.__yantraCsp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__yantraCsp?.push({
        blockedURI: event.blockedURI,
        violatedDirective: event.violatedDirective,
      });
    });
  });
  return {
    page,
    requests,
    pageErrors,
    csp: () => page.evaluate(() => [...(window.__yantraCsp ?? [])]),
  };
}

async function waitConnected(page: Page): Promise<void> {
  await page.waitForSelector('[role="status"][data-status="connected"]', { timeout: 20_000 });
}

beforeAll(async () => {
  if (!existsSync(BIN))
    throw new Error('Run `pnpm build` first: the e2e suite runs the built CLI.');
  home = mkdtempSync(join(tmpdir(), 'yantra-e2e-app-'));
  opened = openUrl();
  origin = `http://127.0.0.1:${opened.port}`;
  browser = await launchGalleryBrowser();
}, TIMEOUT);

/** True while `pid` exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterAll(async () => {
  await browser?.close();
  try {
    process.kill(opened.hostPid);
  } catch {
    // Already gone.
  }
  // Windows releases a killed process's files only once it has exited.
  for (let i = 0; i < 50 && alive(opened.hostPid); i++) {
    await new Promise((done) => setTimeout(done, 100));
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('@no-llm the Yantra app', () => {
  it(
    'connects, stays on 127.0.0.1, violates no CSP, scrubs the code and passes axe',
    async () => {
      // Arrange
      const watched = await watchedPage();

      // Act
      await watched.page.goto(opened.url, { waitUntil: 'load' });
      await waitConnected(watched.page);

      // Assert
      const foreign = watched.requests.filter((url) => new URL(url).origin !== origin);
      expect(foreign).toEqual([]);
      expect(await watched.csp()).toEqual([]);
      expect(watched.pageErrors).toEqual([]);
      expect(watched.page.url()).toBe(`${origin}/`);
      expect(await watched.page.evaluate(() => window.location.hash)).toBe('');
      await watched.page.waitForFunction(
        () => document.documentElement.dataset.surfaces === 'glass',
        {
          timeout: 10_000,
        },
      );
      expect(await runAxe(watched.page, 'body')).toEqual([]);
      await watched.page.close();
    },
    TIMEOUT,
  );

  it(
    'resumes the same window after a reload, without the capability in storage',
    async () => {
      const watched = await watchedPage();
      await watched.page.goto(openUrl().url, { waitUntil: 'load' });
      await waitConnected(watched.page);
      await watched.page.waitForFunction(
        () => sessionStorage.getItem('yantra.resume_code') !== null,
        {
          timeout: 10_000,
        },
      );

      await watched.page.reload({ waitUntil: 'load' });
      await waitConnected(watched.page);

      const storage = await watched.page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      );
      expect(storage).not.toContain('window_capability');
      expect(await watched.csp()).toEqual([]);
      await watched.page.close();
    },
    TIMEOUT,
  );

  it(
    'gives a page on another loopback port neither a session nor a socket',
    async () => {
      // Arrange: a hostile local page that tries the host from the browser.
      const code = new URL(openUrl().url).hash.slice('#code='.length);
      const hostile: Server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><script>
          window.__hostile = { fetch: 'pending', socket: 'pending' };
          fetch('${origin}/session', { method: 'POST', credentials: 'include',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '${code}' }) })
            .then((r) => r.text()).then((t) => { window.__hostile.fetch = 'read:' + t; })
            .catch(() => { window.__hostile.fetch = 'blocked'; });
          const ws = new WebSocket('ws://127.0.0.1:${opened.port}/rpc');
          ws.onopen = () => { window.__hostile.socket = 'open'; };
          ws.onclose = () => { if (window.__hostile.socket === 'pending') window.__hostile.socket = 'refused'; };
        </script>`);
      });
      await new Promise<void>((done) => hostile.listen(0, '127.0.0.1', done));
      const page = await browser.newPage();

      // Act
      await page.goto(`http://127.0.0.1:${(hostile.address() as AddressInfo).port}/`);
      await page.waitForFunction(
        () =>
          window.__hostile !== undefined &&
          window.__hostile.fetch !== 'pending' &&
          window.__hostile.socket !== 'pending',
        { timeout: 15_000 },
      );
      const result = await page.evaluate(() => window.__hostile);

      // Assert
      expect(result).toEqual({ fetch: 'blocked', socket: 'refused' });
      await page.close();
      hostile.closeAllConnections();
      await new Promise((done) => hostile.close(done));
      // The code the hostile page tried was never spent: it still opens a window.
      const ok = await fetch(`${origin}/session`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(ok.status).toBe(200);
    },
    TIMEOUT,
  );
});
