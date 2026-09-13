import { createServer, type Server } from 'node:http';

import type { Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { resolveActionable } from '../../src/locator/auto-wait.js';
import { PuppeteerInjectedScriptHost } from '../../src/locator/injected-host.js';
import { LocatorResolverImpl } from '../../src/locator/resolver.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('@no-llm production InjectedScriptHost', () => {
  let server: Server;
  let baseUrl: string;
  let session: BrowserSession;
  let page: Page;
  let fixture: MigrationBrowserFixture;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Locator fixture</title>
        <style>#cover{position:fixed;left:0;top:0;width:180px;height:60px;z-index:2}</style>
        <button id="covered" style="position:absolute;left:10px;top:10px;width:120px;height:30px">Covered</button>
        <div id="cover">overlay</div>
        <button aria-label="Continue">Next</button>
        <script>setTimeout(() => { const b=document.createElement('button'); b.id='delayed'; b.style.marginTop='120px'; b.textContent='Delayed'; document.body.append(b); }, 80)</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}/`;

    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger,
    }).launch({
      profile: { kind: 'ephemeral' },
      headless: true,
      ...fixture.launchOptions,
    });
    page = await session.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('injects, resolves a semantic candidate, and preserves an element handle', async () => {
    const host = page.locatorHost!;
    const resolver = new LocatorResolverImpl(host);
    const result = await resolver.resolve({
      name: 'Continue',
      strict: true,
      candidates: [
        { source: 'authored', intent: { kind: 'role', role: 'button', name: 'Continue' } },
      ],
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      await expect(result.elementHandle.evaluate((element) => element.textContent)).resolves.toBe(
        'Next',
      );
    }
  });

  it('re-injects after reload', async () => {
    await page.puppeteerPage!.reload({ waitUntil: 'load' });
    await expect(
      page.locatorHost!.call('main', 'resolveCandidate', [
        { kind: 'css', selector: '#covered' },
        true,
      ]),
    ).resolves.toMatchObject({ count: 1 });
  });

  it('reports an intercepted hit target', async () => {
    const host = page.locatorHost!;
    await host.call('main', 'resolveCandidate', [{ kind: 'css', selector: '#covered' }, true]);
    await expect(host.call('main', 'checkHitTarget', [])).resolves.toMatchObject({
      kind: 'intercepted',
    });
  });

  it('auto-waits for a delayed element using the live injected host', async () => {
    await page.goto(baseUrl, { waitUntil: 'load' });
    const result = await resolveActionable(
      {
        name: 'Delayed',
        strict: true,
        candidates: [{ source: 'authored', intent: { kind: 'css', selector: '#delayed' } }],
      },
      page.locatorHost!,
      { timeoutMs: 3_000 },
    );
    expect(result.kind).toBe('success');
  });

  it('resolves live same- and cross-origin frames and rejects a removed frame token', async () => {
    const puppeteerPage = page.puppeteerPage!;
    const host = page.locatorHost as PuppeteerInjectedScriptHost;
    const port = new URL(baseUrl).port;
    await puppeteerPage.evaluate(
      ({ same, cross }) => {
        const first = document.createElement('iframe');
        first.id = 'same-frame';
        first.src = same;
        const second = document.createElement('iframe');
        second.id = 'cross-frame';
        second.src = cross;
        document.body.append(first, second);
      },
      { same: `${baseUrl}?frame=same`, cross: `http://localhost:${port}/?frame=cross` },
    );
    await puppeteerPage.waitForFunction(() => window.frames.length === 2);
    const children = puppeteerPage.frames().filter((frame) => frame !== puppeteerPage.mainFrame());
    const same = children.find((frame) => frame.url().includes('127.0.0.1'))!;
    const cross = children.find((frame) => frame.url().includes('localhost'))!;
    const sameToken = host.getFrameId(same);
    const crossToken = host.getFrameId(cross);

    const sameHandle = await host.callHandle(sameToken, 'document.querySelector("button")');
    const crossHandle = await host.callHandle(crossToken, 'document.querySelector("button")');
    expect(await sameHandle?.evaluate((element) => element.textContent)).toBe('Covered');
    expect(await crossHandle?.evaluate((element) => element.textContent)).toBe('Covered');
    await sameHandle?.dispose();
    await crossHandle?.dispose();

    await same.goto(`${baseUrl}?frame=navigated`, { waitUntil: 'load' });
    await expect(
      host.call(sameToken, 'resolveCandidate', [{ kind: 'css', selector: '#covered' }, true]),
    ).resolves.toMatchObject({ count: 1 });
    await puppeteerPage.evaluate(() => document.querySelector('#same-frame')?.remove());
    await puppeteerPage.waitForFunction(() => window.frames.length === 1);
    await expect(host.call(sameToken, 'resolveCandidate', [])).rejects.toThrow(
      /detached or unknown/,
    );

    await puppeteerPage.evaluate((url) => {
      const replacement = document.createElement('iframe');
      replacement.id = 'same-frame-replacement';
      replacement.src = url;
      document.body.append(replacement);
    }, `${baseUrl}?frame=replacement`);
    await puppeteerPage.waitForFunction(() => window.frames.length === 2);
    const replacement = puppeteerPage
      .frames()
      .find((frame) => frame.url().includes('frame=replacement'))!;
    expect(host.getFrameId(replacement)).not.toBe(sameToken);
  });
});

describe('@no-llm InjectedScriptHost error surfacing', () => {
  // Regression: when a step triggers a navigation, the *next* step's injection
  // check races the old document being torn down and Puppeteer throws
  // "Execution context was destroyed". ensureInjected must surface that cause
  // (so the auto-wait layer can classify it as transient and retry) rather than
  // masking it behind a generic, unclassifiable "Unable to inject" message —
  // which is what turned this workflow's extract step into a fatal `unexpected`.
  it('surfaces the underlying navigation cause instead of masking it', async () => {
    const navError = new Error(
      'Execution context was destroyed, most likely because of a navigation.',
    );
    const frame = { evaluate: vi.fn().mockRejectedValue(navError) };
    const fakePage = {
      evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
      mainFrame: () => frame,
      frames: () => [frame],
    } as unknown as PuppeteerPage;

    const host = new PuppeteerInjectedScriptHost(fakePage, 'STUB_BUNDLE_SOURCE');

    await expect(host.ensureInjected('main')).rejects.toThrow(/Execution context was destroyed/);
    await expect(host.ensureInjected('main')).rejects.toMatchObject({ cause: navError });
  });
});
