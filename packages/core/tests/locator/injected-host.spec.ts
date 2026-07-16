import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserSession, Logger, Page } from '../../src/browser/types.js';
import { resolveActionable } from '../../src/locator/auto-wait.js';
import { LocatorResolverImpl } from '../../src/locator/resolver.js';

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

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>Locator fixture</title>
        <style>#cover{position:fixed;left:0;top:0;width:180px;height:60px;z-index:2}</style>
        <button id="covered" style="position:absolute;left:10px;top:10px;width:120px;height:30px">Covered</button>
        <div id="cover">overlay</div>
        <button aria-label="Continue">Next</button>
        <script>setTimeout(() => { const b=document.createElement('button'); b.id='delayed'; b.style.marginTop='120px'; b.textContent='Delayed'; document.body.append(b); }, 80)</script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}/`;

    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger,
    }).launch({
      profile: { kind: 'ephemeral' },
      headless: true,
    });
    page = await session.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
  }, 30_000);

  afterAll(async () => {
    await session?.close();
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
});
