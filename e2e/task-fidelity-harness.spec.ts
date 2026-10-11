/**
 * @no-llm task-fidelity harness self-tests and census (FEAT-049).
 *
 * The harness is measurement infrastructure: a fixture that drifts from its
 * truth, a host mapping that leaks, or a scripted provider that fakes an error
 * class would make every score it produces meaningless. These tests pin each
 * piece of the harness against the production code it drives.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HttpFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  resetPathCache,
  type BrowserSession,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EgressLog,
  HarnessEgressError,
  hostMappedBrowserProvider,
  mappedRequestFn,
  type HostMappedBrowserProvider,
} from './task-fidelity/fixtures/host-mapping.js';
import { INVENTORY, formatAmount, truthRows } from './task-fidelity/fixtures/inventory.js';
import { serveTaskSites, type TaskSiteServer } from './task-fidelity/fixtures/server.js';
import { TASK_SITES, originOf, renderRoute, siteNamed } from './task-fidelity/fixtures/sites.js';

const neverAborted = (): AbortSignal => new AbortController().signal;

/** The live DOM's serialized markup (the e2e project has no DOM lib types). */
function renderedHtml(page: Awaited<ReturnType<BrowserSession['newPage']>>): Promise<string> {
  return page.evaluate(
    () =>
      (globalThis as unknown as { document: { documentElement: { outerHTML: string } } }).document
        .documentElement.outerHTML,
  );
}

/** A per-suite `YANTRA_HOME`, so Chrome's ephemeral profile never touches the developer's. */
async function useTempHome(): Promise<{ readonly restore: () => Promise<void> }> {
  const previous = process.env.YANTRA_HOME;
  const home = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
  return {
    restore: async () => {
      if (previous === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = previous;
      resetPathCache();
      await rm(home, { recursive: true, force: true });
    },
  };
}

describe('@no-llm task-fidelity fixtures — faceted-listing', () => {
  const site = siteNamed('faceted-listing');
  const render = (route: string): string => {
    const page = renderRoute(site, route);
    if (page === null) throw new Error(`faceted-listing does not serve ${route}`);
    return page.body;
  };

  it('renders every route deterministically, byte for byte', () => {
    expect(site.routes.filter((route) => render(route) !== render(route))).toEqual([]);
  });

  it('shows each item’s price and seller on its listing page', () => {
    const missing = truthRows().filter((row) => {
      const listing = render(new URL(row.listingUrl).pathname + new URL(row.listingUrl).search);
      return (
        !listing.includes(`>${row.fields.price}<`) || !listing.includes(`>${row.fields.seller}</a>`)
      );
    });
    expect(missing.map((row) => row.itemId)).toEqual([]);
  });

  it('shows each item’s truth colors on its detail page, and only there', () => {
    const missing = truthRows().filter((row) => {
      const detail = render(new URL(row.detailUrl).pathname);
      return (
        !detail.includes(`<dd>${row.fields.exteriorColor}</dd>`) ||
        !detail.includes(`<dd>${row.fields.interiorColor}</dd>`) ||
        !detail.includes(`>${row.fields.seller}</a>`)
      );
    });
    expect(missing.map((row) => row.itemId)).toEqual([]);
    const listings = site.routes.filter((route) => route.startsWith('/new/results')).map(render);
    const leaked = INVENTORY.filter((entry) =>
      listings.some((page) => page.includes(entry.interiorColor)),
    );
    expect(leaked.map((entry) => entry.id)).toEqual([]);
  });

  it('counts the AWD facet as exactly the AWD truth rows', () => {
    const awd = truthRows().filter((row) => row.fields.drivetrain === 'AWD').length;
    expect(render('/new/results')).toContain(`AWD (${awd})</a>`);
    const filtered = render('/new/results?drivetrain=AWD');
    expect(filtered).toContain(`${awd} results`);
    for (const row of truthRows().filter((candidate) => candidate.fields.drivetrain === 'FWD')) {
      expect(filtered).not.toContain(`href="/vehicle/${row.itemId}"`);
    }
  });

  it('links each facet to a variant of the current URL', () => {
    const page = render('/new/results?drivetrain=AWD');
    expect(page).toContain('href="/new/results?drivetrain=FWD"');
    expect(page).toContain('href="/new/results?drivetrain=AWD&amp;trim=Summit"');
    expect(page).toContain('href="/new/results?drivetrain=AWD&amp;page=2"');
  });

  it('serves the G2 regression card first: a plain-text price with linked title and seller', () => {
    const first = INVENTORY[0];
    if (first === undefined) throw new Error('empty inventory');
    const card = render('/new/results').split('<li class="listing-card">')[1] ?? '';
    expect(card).toContain(`<span class="price">${formatAmount(first.price)}</span>`);
    expect(card).toMatch(
      /<h3><a href="\/vehicle\/itm-01">New 2026 Norvale Teyra Summit<\/a><\/h3>/,
    );
    expect(card).toContain(`>${first.seller}</a>`);
    expect(card).toContain('27.0 mi away');
  });

  it('returns null for a path the site does not serve', () => {
    expect(renderRoute(site, '/vehicle/itm-99')).toBeNull();
    expect(renderRoute(site, '/nowhere')).toBeNull();
  });
});

describe('@no-llm task-fidelity host mapping — HTTP', () => {
  let server: TaskSiteServer;

  beforeAll(async () => {
    server = await serveTaskSites();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('serves every faceted-listing route through the production HttpFetcher', async () => {
    const fetcher = new HttpFetcher({ requestFn: mappedRequestFn(server.port) });
    const served: [string, number, string | null][] = [];
    for (const route of siteNamed('faceted-listing').routes) {
      const doc = await fetcher.fetch(`${originOf('faceted-listing')}${route}`, {
        timeoutMs: 5_000,
        signal: neverAborted(),
      });
      served.push([route, doc.statusCode, doc.contentType]);
    }
    expect(served).toEqual(
      siteNamed('faceted-listing').routes.map((route) => [route, 200, 'text/html; charset=utf-8']),
    );
  });

  it('answers an unknown host and an unknown path with 404, and logs both', async () => {
    server.reset();
    const fetcher = new HttpFetcher({ requestFn: mappedRequestFn(server.port) });
    const options = { timeoutMs: 5_000, signal: neverAborted() };

    await expect(fetcher.fetch('http://unknown-site.yantra.test/', options)).rejects.toMatchObject({
      context: { kind: 'http-status', statusCode: 404 },
    });
    await expect(
      fetcher.fetch('http://faceted-listing.yantra.test/missing?x=1', options),
    ).rejects.toMatchObject({ context: { kind: 'http-status', statusCode: 404 } });

    expect(server.requests()).toEqual([
      expect.objectContaining({
        host: 'unknown-site.yantra.test',
        path: '/',
        query: '',
        status: 404,
        userAgentClass: 'http',
        robots: false,
      }),
      expect.objectContaining({
        host: 'faceted-listing.yantra.test',
        path: '/missing',
        query: 'x=1',
        status: 404,
      }),
    ]);
  });

  it('serves an allow-all robots.txt on every fixture host and flags it in the log', async () => {
    server.reset();
    const response = await mappedRequestFn(server.port)(
      'http://faceted-listing.yantra.test/robots.txt',
      {
        method: 'GET',
      },
    );
    let text = '';
    for await (const chunk of response.body) text += String(chunk);
    expect(response.statusCode).toBe(200);
    expect(text).toBe('User-agent: *\nAllow: /\n');
    expect(server.requests()).toEqual([expect.objectContaining({ robots: true, status: 200 })]);
  });

  it('refuses a non-fixture, non-loopback host with HarnessEgressError and records it', async () => {
    const egress = new EgressLog();
    const requestFn = mappedRequestFn(server.port, egress);
    server.reset();

    await expect(requestFn('http://example.org/', { method: 'GET' })).rejects.toBeInstanceOf(
      HarnessEgressError,
    );
    await expect(requestFn('https://sub.example.org/x', { method: 'GET' })).rejects.toThrow(
      /sub\.example\.org/,
    );

    expect(egress.hosts()).toEqual(['example.org', 'sub.example.org']);
    expect(server.requests()).toEqual([]);
  });

  it('keeps the HttpFetcher’s refusal visible through the egress log, not only its error', async () => {
    const egress = new EgressLog();
    const fetcher = new HttpFetcher({ requestFn: mappedRequestFn(server.port, egress) });
    await expect(
      fetcher.fetch('http://example.org/', { timeoutMs: 5_000, signal: neverAborted() }),
    ).rejects.toMatchObject({ context: { kind: 'network' } });
    expect(egress.hosts()).toEqual(['example.org']);
  });

  it('logs requests in arrival order with the host label routed', async () => {
    server.reset();
    const fetcher = new HttpFetcher({ requestFn: mappedRequestFn(server.port) });
    await fetcher.fetch(`${originOf('faceted-listing')}/vehicle/itm-03`, {
      timeoutMs: 5_000,
      signal: neverAborted(),
    });
    await fetcher.fetch(`${originOf('faceted-listing')}/new/results?page=2`, {
      timeoutMs: 5_000,
      signal: neverAborted(),
    });
    expect(server.requests().map((entry) => [entry.seq, entry.path, entry.query])).toEqual([
      [1, '/vehicle/itm-03', ''],
      [2, '/new/results', 'page=2'],
    ]);
  });
});

describe('@no-llm task-fidelity host mapping — real Chrome', () => {
  let server: TaskSiteServer;
  let home: { readonly restore: () => Promise<void> };
  let inner: LocalBrowserProvider;
  let provider: HostMappedBrowserProvider<LocalBrowserProvider>;
  let session: BrowserSession | undefined;

  beforeAll(async () => {
    home = await useTempHome();
    server = await serveTaskSites();
    inner = new LocalBrowserProvider({ profileStore: new LocalProfileStore() });
    provider = hostMappedBrowserProvider(inner, server.port);
    session = await provider.launch({ profile: { kind: 'ephemeral' }, headless: true });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await server?.close();
    await home?.restore();
  });

  it('routes a fixture hostname to the loopback server by Host header', async () => {
    if (session === undefined) throw new Error('no browser session');
    server.reset();
    const page = await session.newPage();
    try {
      await page.goto(`${originOf('faceted-listing')}/new/results`, { waitUntil: 'load' });
      expect(await renderedHtml(page)).toContain('<h1>Norvale Teyra for sale near you</h1>');
      expect(page.url()).toBe('http://faceted-listing.yantra.test/new/results');
    } finally {
      await page.close();
    }
    const documents = server.requests().filter((entry) => entry.path === '/new/results');
    expect(documents).toEqual([
      expect.objectContaining({ host: 'faceted-listing.yantra.test', userAgentClass: 'browser' }),
    ]);
  }, 30_000);

  it('fails a non-fixture navigation without reaching the network', async () => {
    if (session === undefined) throw new Error('no browser session');
    server.reset();
    const page = await session.newPage();
    try {
      await expect(page.goto('http://example.org/', { waitUntil: 'load' })).rejects.toThrow(
        /ERR_NAME_NOT_RESOLVED/,
      );
    } finally {
      await page.close();
    }
    expect(server.requests()).toEqual([]);
  }, 30_000);

  it('counts exactly one launch and delegates every other member unchanged', async () => {
    expect(provider.launchCount).toBe(1);
    expect(provider).toBeInstanceOf(LocalBrowserProvider);
    const members = new Set<string>();
    for (
      let proto: object | null = Object.getPrototypeOf(inner) as object | null;
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name !== 'constructor') members.add(name);
      }
    }
    const memberType = (target: object, name: string): string =>
      typeof (target as Record<string, unknown>)[name];
    expect(members.size).toBeGreaterThan(1);
    expect([...members].map((name) => [name, memberType(provider, name)])).toEqual(
      [...members].map((name) => [name, memberType(inner, name)]),
    );
    await expect(provider.detectChrome()).resolves.toEqual(await inner.detectChrome());
  }, 30_000);
});

describe('@no-llm task-fidelity site registry', () => {
  it('registers each site under its own reserved hostname', () => {
    for (const site of TASK_SITES) {
      expect(site.host).toBe(`${site.name}.yantra.test`);
      expect(originOf(site.name)).toBe(`http://${site.host}`);
    }
  });
});
