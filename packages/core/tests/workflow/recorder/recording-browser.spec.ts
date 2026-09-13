// @no-llm
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import type { Browser, Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RecordingSession } from '../../../src/workflow/recorder/session.js';
import {
  FileSystemRecordingStore,
  type RecordingStore,
} from '../../../src/workflow/recorder/store.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../../helpers/migration-browser.js';

const runMigrationBrowser =
  Boolean(process.env.YANTRA_TEST_BROWSER_PATH) ||
  process.env.YANTRA_MIGRATION_SUITE_REQUIRED === '1';

describe.runIf(runMigrationBrowser)('@no-llm real recorder popup session migration', () => {
  let server: Server;
  let baseUrl: string;
  let fixture: MigrationBrowserFixture;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture({ requireProvisioned: true });
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      response.writeHead(200, { 'content-type': 'text/html' });
      if (path === '/popup') {
        response.end(`<!doctype html><title>Recorded popup</title>
          <input id="popup-value" aria-label="Popup value">
          <button id="grandchild" onclick="window.open('/grandchild')">Open child</button>`);
        return;
      }
      if (path === '/grandchild') {
        response.end(`<!doctype html><title>Recorded grandchild</title>
          <input id="grandchild-value" aria-label="Grandchild value">`);
        return;
      }
      response.end(`<!doctype html><title>Recorder main</title>
        <input id="main-value" aria-label="Main value">
        <button id="popup" onclick="window.open('/popup')">Open popup</button>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('recorder fixture did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await fixture?.cleanup();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('records main, popup, and grandchild actions once on their child sessions', async () => {
    const backingStore = new FileSystemRecordingStore(join(fixture.yantraHome, 'recordings'));
    const store: RecordingStore = {
      create: backingStore.create.bind(backingStore),
      appendAction: backingStore.appendAction.bind(backingStore),
      saveDraft: backingStore.saveDraft.bind(backingStore),
      loadDraft: backingStore.loadDraft.bind(backingStore),
      destroy: () => Promise.resolve(),
    };
    const recording = new RecordingSession({ store });
    const handle = await recording.start('popup-session-migration', {
      chromeOverridePath: fixture.executablePath,
      idleTimeoutMs: 60_000,
    });
    const events: { kind: string; targetId?: string; url?: string }[] = [];
    handle.events.on('event', (event) => events.push(event));
    const internals = recording as unknown as { mainPage: Page; browser: Browser };
    const canary = 'CANARY-recorder-secret';

    try {
      await internals.mainPage.goto(baseUrl, { waitUntil: 'load' });
      await internals.mainPage.type('#main-value', 'main');
      await internals.mainPage.click('#popup');
      await waitFor(() => events.filter((event) => event.kind === 'popup_attached').length >= 1);

      const popup = await pageWithTitle(internals.browser, 'Recorded popup');
      await emitInput(popup, '#popup-value', canary);
      await waitFor(
        () =>
          events.filter(
            (event) => event.kind === 'capture_emitted' && event.url?.includes('/popup'),
          ).length > 0,
      );
      await popup.click('#grandchild');
      await waitFor(() => events.filter((event) => event.kind === 'popup_attached').length >= 2);

      const grandchild = await pageWithTitle(internals.browser, 'Recorded grandchild');
      const capturedBefore = events.filter((event) => event.kind === 'capture_emitted').length;
      await emitInput(grandchild, '#grandchild-value', 'child');
      await waitFor(
        () =>
          events.filter(
            (event) => event.kind === 'capture_emitted' && event.url?.includes('/grandchild'),
          ).length > 0,
      );
      expect(events.filter((event) => event.kind === 'capture_emitted').length).toBeGreaterThan(
        capturedBefore,
      );

      const { draftPath } = await recording.stop('user');
      const draftText = await readFile(draftPath, 'utf8');
      const draft = JSON.parse(draftText) as {
        actions: { kind: string; raw_value?: string; url_before?: string }[];
      };
      const popupFills = draft.actions.filter(
        (action) => action.kind === 'fill' && action.url_before?.includes('/popup'),
      );
      const grandchildFills = draft.actions.filter(
        (action) => action.kind === 'fill' && action.url_before?.includes('/grandchild'),
      );

      expect(popupFills).toHaveLength(1);
      expect(grandchildFills).toHaveLength(1);
      expect(popupFills[0]?.raw_value).toBe('<redacted>');
      expect(draftText).not.toContain(canary);
      expect(events.filter((event) => event.kind === 'recording_degraded')).toHaveLength(0);
    } finally {
      if (recording.currentState === 'recording' || recording.currentState === 'paused') {
        await recording.abort('schema_drift');
      }
    }
  }, 90_000);
});

async function pageWithTitle(browser: Browser, title: string): Promise<Page> {
  let selected: Page | undefined;
  await waitFor(async () => {
    const pages = await browser.pages();
    selected = pages.find((page) => page.url() !== 'about:blank' && page.url() !== '');
    for (const page of pages) {
      if ((await page.title().catch(() => '')) === title) {
        selected = page;
        return true;
      }
    }
    return false;
  });
  if (!selected) throw new Error(`missing page titled ${title}`);
  return selected;
}

async function emitInput(page: Page, selector: string, value: string): Promise<void> {
  await page.$eval(
    selector,
    (element, nextValue) => {
      const input = element as HTMLInputElement;
      input.value = nextValue;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    },
    value,
  );
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for recorder condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
