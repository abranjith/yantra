import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PagePool } from '../../../src/browser/page-pool.js';
import type { PageSource } from '../../../src/browser/page-source.js';
import { LocalProfileStore } from '../../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../../src/browser/provider.js';
import type { Page } from '../../../src/browser/types.js';
import { ScrapeSearchError } from '../../../src/extraction/search/errors.js';
import {
  ScrapeTransport,
  type SearchEthicsGate,
} from '../../../src/extraction/search/scrape-transport.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../../helpers/migration-browser.js';

import { fakeBrowserProvider, passGate, refuseGate, silentLogger } from './helpers.js';

const SERP_URL = 'https://html.duckduckgo.com/html/?q=ai+news';
const FORM_PAGE = 'https://search.example/html/';
const FORM = { pageUrl: FORM_PAGE, field: 'q', query: 'ai news' } as const;

/** An ethics gate that passes everything and records what it was asked. */
function recordingGate(refuse: (url: string) => boolean = () => false): {
  readonly gate: SearchEthicsGate;
  readonly checked: string[];
} {
  const checked: string[] = [];
  return {
    checked,
    gate: {
      checkUrl: (url) => {
        checked.push(url);
        return Promise.resolve(
          refuse(url) ? { ok: false, reason: 'robots', detail: 'Disallowed' } : { ok: true },
        );
      },
    },
  };
}

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

describe('@no-llm extraction/search/scrape-transport submitSerpForm', () => {
  it('opens the search page without the query and submits the query through its form', async () => {
    const browser = fakeBrowserProvider('<html><body>results</body></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    const html = await transport.submitSerpForm(FORM, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    expect(html).toContain('results');
    expect(browser.visited()).toEqual([FORM_PAGE]);
    expect(browser.submissions()).toEqual([{ field: 'q', query: 'ai news' }]);
  });

  it('starts waiting for the navigation before it submits, then reads the new page', async () => {
    const calls: string[] = [];
    const page: Page = {
      goto: () => {
        calls.push('goto');
        return Promise.resolve(null);
      },
      waitForNavigation: () => {
        calls.push('waitForNavigation');
        return Promise.resolve(null);
      },
      evaluate: <T, A>(_fn: (arg: A) => T, arg?: A) => {
        if (typeof arg === 'string') {
          calls.push('locate');
          return Promise.resolve(FORM_PAGE as unknown as T);
        }
        calls.push(arg === undefined ? 'read' : 'submit');
        return Promise.resolve('<html></html>' as unknown as T);
      },
      close: () => Promise.resolve(),
      url: () => FORM_PAGE,
      on: () => undefined,
    };
    const transport = new ScrapeTransport({
      pages: { withPage: (fn) => fn(page) },
      ethicsGate: passGate,
      logger: silentLogger,
    });

    await transport.submitSerpForm(FORM, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    expect(calls).toEqual(['goto', 'locate', 'waitForNavigation', 'submit', 'read']);
  });

  it('runs the ethics gate on the search page and on the form target', async () => {
    const browser = fakeBrowserProvider('<html></html>', {
      formAction: 'https://search.example/results',
    });
    const { gate, checked } = recordingGate();
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: gate,
      logger: silentLogger,
    });

    await transport.submitSerpForm(FORM, {
      signal: new AbortController().signal,
      provider: 'duckduckgo',
    });

    expect(checked).toEqual([FORM_PAGE, 'https://search.example/results']);
  });

  it('refuses before taking a page when the ethics gate blocks the search page', async () => {
    const browser = fakeBrowserProvider('<html></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: refuseGate('robots', 'Disallowed by robots.txt'),
      logger: silentLogger,
    });

    const error = await transport
      .submitSerpForm(FORM, { signal: new AbortController().signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context.code).toContain('ethics-refused');
    expect(browser.launches()).toBe(0);
  });

  it('never submits when the ethics gate blocks the form target', async () => {
    const browser = fakeBrowserProvider('<html></html>', {
      formAction: 'https://tracker.example/collect',
    });
    const { gate } = recordingGate((url) => url.startsWith('https://tracker.example/'));
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: gate,
      logger: silentLogger,
    });

    const error = await transport
      .submitSerpForm(FORM, { signal: new AbortController().signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    const err = error as ScrapeSearchError;
    expect(err.context.code).toBe('ethics-refused:robots:Disallowed');
    expect(err.context.host).toBe('tracker.example');
    expect(browser.submissions()).toEqual([]);
  });

  it('reports search-form-missing, without submitting, when the page has no such field', async () => {
    const browser = fakeBrowserProvider('<html></html>', { formAction: null });
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    const error = await transport
      .submitSerpForm(FORM, { signal: new AbortController().signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ScrapeSearchError);
    const err = error as ScrapeSearchError;
    expect(err.context.code).toBe('search-form-missing');
    expect(err.context.host).toBe('search.example');
    expect(err.message).toContain('"q"');
    expect(browser.submissions()).toEqual([]);
  });

  it('throws an aborted error without launching when the signal is already aborted', async () => {
    const browser = fakeBrowserProvider('<html></html>');
    const transport = new ScrapeTransport({
      pages: browser.pages,
      ethicsGate: passGate,
      logger: silentLogger,
    });
    const controller = new AbortController();
    controller.abort();

    const error = await transport
      .submitSerpForm(FORM, { signal: controller.signal, provider: 'duckduckgo' })
      .catch((e: unknown) => e);

    expect((error as ScrapeSearchError).context.code).toBe('aborted');
    expect(browser.launches()).toBe(0);
  });
});

describe('@no-llm extraction/search/scrape-transport submitSerpForm against real Chrome', () => {
  let fixture: MigrationBrowserFixture;
  let server: Server;
  let baseUrl: string;
  const requests: { readonly method: string; readonly path: string; readonly body: string }[] = [];

  // A decoy hidden `q` in an earlier form, and a control named "action" that
  // shadows `form.action`, so a naive lookup picks the wrong form or target.
  const SEARCH_PAGE =
    '<!doctype html><html><body>' +
    '<form method="post" action="/decoy"><input type="hidden" name="q" value="old"></form>' +
    '<form method="post" action="/results">' +
    '<input type="hidden" name="action" value="shadow">' +
    '<input type="text" name="q">' +
    '<select name="kl"><option value="us-en" selected>US</option></select>' +
    '<input type="submit" name="b" value="">' +
    '</form></body></html>';

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        const path = request.url ?? '';
        if (path !== '/favicon.ico') requests.push({ method: request.method ?? '', path, body });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (path === '/search') {
          response.end(SEARCH_PAGE);
        } else if (path === '/results' && request.method === 'POST') {
          response.end(
            '<html><body><a class="result__a" href="https://example.com/one">One</a></body></html>',
          );
        } else {
          response.end('<html><body><p>no search here</p></body></html>');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture?.cleanup();
  });

  function realPool(): PagePool {
    const real = new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silentLogger,
    });
    return new PagePool({
      provider: {
        launch: (options) => real.launch({ ...options, ...fixture.launchOptions }),
        detectChrome: () => real.detectChrome(),
      },
    });
  }

  it('posts the form owning the visible field with what Enter sends, never a GET with the query', async () => {
    requests.length = 0;
    const pool = realPool();
    const { gate, checked } = recordingGate();
    const transport = new ScrapeTransport({ pages: pool, ethicsGate: gate, logger: silentLogger });
    const query = 'ai news & café';

    try {
      const html = await transport.submitSerpForm(
        { pageUrl: `${baseUrl}/search`, field: 'q', query },
        { signal: new AbortController().signal, provider: 'duckduckgo' },
      );

      expect(html).toContain('class="result__a"');
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'GET /search',
        'POST /results',
      ]);
      const posted = new URLSearchParams(requests[1]?.body);
      expect(posted.get('q')).toBe(query);
      expect(posted.get('kl')).toBe('us-en');
      expect(posted.get('b')).toBe('');
      expect(posted.get('action')).toBe('shadow');
      expect(checked).toEqual([`${baseUrl}/search`, `${baseUrl}/results`]);
    } finally {
      await pool.close();
    }
  }, 90_000);

  it('reports search-form-missing on a page without the field and sends nothing more', async () => {
    requests.length = 0;
    const pool = realPool();
    const transport = new ScrapeTransport({
      pages: pool,
      ethicsGate: passGate,
      logger: silentLogger,
    });

    try {
      const error = await transport
        .submitSerpForm(
          { pageUrl: `${baseUrl}/plain`, field: 'q', query: 'ai news' },
          { signal: new AbortController().signal, provider: 'duckduckgo' },
        )
        .catch((e: unknown) => e);

      expect((error as ScrapeSearchError).context.code).toBe('search-form-missing');
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /plain']);
    } finally {
      await pool.close();
    }
  }, 90_000);
});

function stubPage(html: string): Page {
  return {
    goto: () => Promise.resolve(null),
    waitForNavigation: () => Promise.resolve(null),
    evaluate: <T>() => Promise.resolve(html as unknown as T),
    close: () => Promise.resolve(),
    url: () => SERP_URL,
    on: () => undefined,
  };
}
