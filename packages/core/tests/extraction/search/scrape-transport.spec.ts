import { describe, expect, it } from 'vitest';

import { PagePool } from '../../../src/browser/page-pool.js';
import type { PageSource } from '../../../src/browser/page-source.js';
import type { Page } from '../../../src/browser/types.js';
import { ScrapeSearchError } from '../../../src/extraction/search/errors.js';
import { ScrapeTransport } from '../../../src/extraction/search/scrape-transport.js';

import { fakeBrowserProvider, passGate, refuseGate, silentLogger } from './helpers.js';

const SERP_URL = 'https://html.duckduckgo.com/html/?q=ai+news';

describe('@no-llm extraction/search/scrape-transport', () => {
  it('returns the rendered SERP html through the shared browser launcher', async () => {
    const browser = fakeBrowserProvider('<html><body>results</body></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    const html = await transport.fetchSerp(SERP_URL, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    expect(html).toContain('results');
    expect(browser.launches()).toBe(1);
  });

  it('leaves compatibility identity to the core launcher instead of overriding it per transport', async () => {
    const browser = fakeBrowserProvider('<html></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    await transport.fetchSerp(SERP_URL, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    const args = browser.lastExtraArgs();
    expect(args).toEqual([]);
    expect(browser.lastHeadless()).toBe(true);
  });

  it('refuses before browser launch when the ethics gate blocks the url', async () => {
    const browser = fakeBrowserProvider('<html></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: refuseGate('robots', 'Disallowed by robots.txt at "html.duckduckgo.com"'),
      logger: silentLogger,
    });

    const error = await transport
      .fetchSerp(SERP_URL, { signal: new AbortController().signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    const err = error as ScrapeSearchError;
    expect(err.message).toContain('robots');
    expect(err.message).toContain('Disallowed by robots.txt');
    expect(err.context.code).toContain('ethics-refused');
    expect(browser.launches()).toBe(0);
  });

  it('throws an aborted error when the signal is already aborted', async () => {
    const browser = fakeBrowserProvider('<html></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    const controller = new AbortController();
    controller.abort();

    const error = await transport
      .fetchSerp(SERP_URL, { signal: controller.signal, provider: 'google' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toBe('aborted');
    expect(browser.launches()).toBe(0);
  });

  it('runs the ethics gate before it takes a page', async () => {
    const order: string[] = [];
    const pages: PageSource = {
      withPage: (fn) => {
        order.push('page');
        return fn(stubPage('<html></html>'));
      },
    };
    const transport = new ScrapeTransport({
      pages,
      ethicsGate: {
        checkUrl: () => {
          order.push('ethics');
          return Promise.resolve({ ok: true });
        },
      },
      logger: silentLogger,
    });

    await transport.fetchSerp(SERP_URL, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    expect(order).toEqual(['ethics', 'page']);
  });

  it('maps a SERP render past its deadline to a typed timeout', async () => {
    const pages: PageSource = {
      withPage: (fn, opts) =>
        new PagePool({
          provider: fakeBrowserProvider('<html></html>').provider,
        }).withPage(() => new Promise<never>(() => undefined), {
          ...opts,
          timeoutMs: 5,
        }) as ReturnType<typeof fn>,
    };
    const transport = new ScrapeTransport({ pages, ethicsGate: passGate, logger: silentLogger });

    const error = await transport
      .fetchSerp(SERP_URL, { signal: new AbortController().signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toBe('timeout');
  });

  it('shares one browser across searches when given the run page pool', async () => {
    const browser = fakeBrowserProvider('<html><body>r</body></html>');
    const pool = new PagePool({ provider: browser.provider });
    const transport = new ScrapeTransport({
      pages: pool,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    for (let i = 0; i < 3; i += 1) {
      await transport.fetchSerp(`${SERP_URL}&n=${i}`, {
        signal: new AbortController().signal,
        provider: 'duckduckgo',
      });
    }
    await pool.close();

    expect(browser.launches()).toBe(1);
    expect(pool.stats().contexts).toBe(3);
  });
});

function stubPage(html: string): Page {
  return {
    goto: () => Promise.resolve(null),
    evaluate: <T>() => Promise.resolve(html as unknown as T),
    close: () => Promise.resolve(),
    url: () => SERP_URL,
    on: () => undefined,
  };
}
