import { describe, expect, it } from 'vitest';

import { ScrapeSearchError } from '../../../src/extraction/search/errors.js';
import { ScrapeTransport } from '../../../src/extraction/search/scrape-transport.js';

import { fakeBrowserProvider, passGate, refuseGate, silentLogger } from './helpers.js';

const SERP_URL = 'https://html.duckduckgo.com/html/?q=ai+news';

describe('@no-llm extraction/search/scrape-transport', () => {
  it('returns the rendered SERP html through the shared browser launcher', async () => {
    const browser = fakeBrowserProvider('<html><body>results</body></html>');
    const transport = new ScrapeTransport({
      browserProvider: browser.provider,
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
      browserProvider: browser.provider,
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
      browserProvider: browser.provider,
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
      browserProvider: browser.provider,
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
});
