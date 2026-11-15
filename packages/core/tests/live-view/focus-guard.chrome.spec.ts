// @no-llm
/**
 * FEAT-069 TASK-004 in real Chrome (memory: an in-page function needs one
 * real-Chrome test, because jsdom cannot prove it is self-contained).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { ProtectedFocusState } from '../../src/browser/screen-protection.js';
import type { BrowserSession, Logger } from '../../src/browser/types.js';
import { LiveViewError } from '../../src/live-view/errors.js';
import { installFocusGuard, type FocusGuardHandle } from '../../src/live-view/focus-guard.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

async function until(
  predicate: () => boolean,
  timeoutMs = 5_000,
  describe?: () => unknown,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`condition not met in time: ${String(describe?.())}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('@no-llm focus guard in real Chrome', () => {
  let fixture: MigrationBrowserFixture;
  let session: BrowserSession;
  let page: PuppeteerPage;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = request.url ?? '/';
      const body =
        path === '/inner'
          ? '<!doctype html><input id="inner" type="text">'
          : `<!doctype html><input id="outer"><iframe src="http://localhost:${port}/inner"></iframe>`;
      response.writeHead(200, { 'content-type': 'text/html' }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    fixture = await beginMigrationBrowserFixture();
    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silent,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true, ...fixture.launchOptions });
    page = (await session.newPage()).puppeteerPage!;
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
    await new Promise((resolve) => server?.close(resolve));
  });

  async function guard(): Promise<{
    readonly reports: ProtectedFocusState[];
    readonly handle: FocusGuardHandle;
  }> {
    const reports: ProtectedFocusState[] = [];
    const handle = await installFocusGuard(page, (state) => reports.push(state));
    return { reports, handle };
  }

  const last = (reports: readonly ProtectedFocusState[]) => reports[reports.length - 1];

  it('reports unknown at once, then the page state', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password">');
    const { reports, handle } = await guard();
    try {
      expect(reports[0]).toBe('unknown');
      await until(() => last(reports) === 'clear');
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('reports protected on a password focus and clear on blur', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password"><input id="q">');
    const { reports, handle } = await guard();
    try {
      await until(() => last(reports) === 'clear');
      await page.focus('#pw');
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
      await page.$eval('#pw', (element) => (element as HTMLInputElement).blur());
      await until(() => last(reports) === 'clear');
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('follows a type switch on the focused field, both ways', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="f" type="password">');
    const { reports, handle } = await guard();
    try {
      await page.focus('#f');
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
      await page.$eval('#f', (element) => element.setAttribute('type', 'text'));
      await until(() => last(reports) === 'clear');
      await page.$eval('#f', (element) => element.setAttribute('type', 'password'));
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('reports unknown for focus inside a cross-origin iframe', async () => {
    await page.goto(`http://127.0.0.1:${port}/`);
    const { reports, handle } = await guard();
    try {
      await until(() => last(reports) === 'clear');
      const inner = page.frames().find((frame) => frame.url().startsWith('http://localhost'));
      expect(inner).toBeDefined();
      await inner!.focus('#inner');
      await until(() => last(reports) === 'unknown');
      await page.focus('#outer');
      await until(() => last(reports) === 'clear');
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('is invisible to main-world scripts and mutates nothing across a focus cycle', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password"><input id="q">');
    await page.evaluate(() => {
      const scope = window as unknown as { __mutations: number };
      scope.__mutations = 0;
      new MutationObserver((records) => {
        scope.__mutations += records.length;
      }).observe(document, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
    });
    const { reports, handle } = await guard();
    try {
      await page.focus('#pw');
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
      await page.focus('#q');
      await until(() => last(reports) === 'clear');
      const mainWorld = await page.evaluate(() => {
        const names = Object.getOwnPropertyNames(window).filter((name) =>
          name.startsWith('__yantraLiveView'),
        );
        return {
          names,
          mutations: (window as unknown as { __mutations: number }).__mutations,
        };
      });
      expect(mainWorld).toEqual({ names: [], mutations: 0 });
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('survives a real navigation to a new document', async () => {
    await page.goto('about:blank');
    const { reports, handle } = await guard();
    try {
      await page.goto('about:blank');
      await page.setContent('<input id="pw" type="password">');
      await page.focus('#pw');
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
      await page.goto(`http://127.0.0.1:${port}/`);
      await until(() => last(reports) === 'clear');
      await page.focus('#outer');
      await page.$eval('#outer', (element) => element.setAttribute('autocomplete', 'cc-number'));
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
    } finally {
      await handle.dispose();
    }
  }, 30_000);

  it('sees focus move in a background tab, where Chrome fires no focus events', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password">');
    const other = (await session.newPage()).puppeteerPage!;
    await other.bringToFront();
    const { reports, handle } = await guard();
    try {
      await until(() => last(reports) === 'clear');
      expect(await page.evaluate(() => document.hasFocus())).toBe(false);
      await page.focus('#pw');
      await until(
        () => last(reports) === 'protected',
        5_000,
        () => reports.join(','),
      );
    } finally {
      await handle.dispose();
      await other.close();
      await page.bringToFront();
    }
  }, 30_000);

  it('reports through the new binding when installed again on the same document', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password">');
    const first = await guard();
    await first.handle.dispose();
    await page.focus('#pw');
    const second = await guard();
    try {
      await until(
        () => last(second.reports) === 'protected',
        5_000,
        () => second.reports.join(','),
      );
    } finally {
      await second.handle.dispose();
    }
  }, 30_000);

  it('stops reporting after dispose, and dispose is idempotent', async () => {
    await page.goto('about:blank');
    await page.setContent('<input id="pw" type="password">');
    const { reports, handle } = await guard();
    await until(() => last(reports) === 'clear');
    await handle.dispose();
    await handle.dispose();
    const count = reports.length;
    await page.focus('#pw');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(reports).toHaveLength(count);
  }, 30_000);

  it('reports unknown and rejects with FOCUS_GUARD_UNAVAILABLE when install fails', async () => {
    const reports: ProtectedFocusState[] = [];
    await expect(
      installFocusGuard(page, (state) => reports.push(state), {
        createSession: () => Promise.reject(new Error('target closed')),
      }),
    ).rejects.toMatchObject({ name: 'LiveViewError', code: 'FOCUS_GUARD_UNAVAILABLE' });
    expect(reports).toEqual(['unknown', 'unknown']);
    await expect(
      installFocusGuard(page, () => undefined, {
        createSession: () => Promise.reject(new Error('x')),
      }),
    ).rejects.toBeInstanceOf(LiveViewError);
  }, 30_000);
});
