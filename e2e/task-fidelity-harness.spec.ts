/**
 * @no-llm task-fidelity harness self-tests and census (FEAT-049).
 *
 * The harness is measurement infrastructure: a fixture that drifts from its
 * truth, a host mapping that leaks, or a scripted provider that fakes an error
 * class would make every score it produces meaningless. These tests pin each
 * piece of the harness against the production code it drives.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HttpFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ScrapeSearchError,
  resetPathCache,
  type BrowserSession,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ARTICLE_FACTS, ARTICLE_SECTIONS } from './task-fidelity/fixtures/article-corpus.js';
import { ARTICLE_PATH } from './task-fidelity/fixtures/article.js';
import {
  fixtureSources,
  loadSiteTokenPattern,
  siteCensus,
  sourceLiteralFindings,
  truthPlacementFindings,
  type CensusSite,
} from './task-fidelity/fixtures/census.js';
import {
  CHALLENGE_PATHS,
  ESCALATION_SIZE_BYTES,
} from './task-fidelity/fixtures/challenge-interstitial.js';
import {
  EgressLog,
  HarnessEgressError,
  hostMappedBrowserProvider,
  mappedRequestFn,
  type HostMappedBrowserProvider,
} from './task-fidelity/fixtures/host-mapping.js';
import { htmlPage } from './task-fidelity/fixtures/html.js';
import { INVENTORY, formatAmount, truthRows } from './task-fidelity/fixtures/inventory.js';
import { MULTI_TABLE_ANSWER, MULTI_TABLE_PATH } from './task-fidelity/fixtures/multi-table.js';
import { serveTaskSites, type TaskSiteServer } from './task-fidelity/fixtures/server.js';
import {
  TASK_SITES,
  originOf,
  renderRoute,
  siteNamed,
  type SiteName,
} from './task-fidelity/fixtures/sites.js';
import { structuredPageItems } from './task-fidelity/fixtures/structured-listing.js';
import {
  ScriptedSearchProvider,
  scriptedSearchLeaf,
} from './task-fidelity/search/scripted-provider.js';

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

  it('renders all six page-1 client-rendered cards in the DOM after load', async () => {
    if (session === undefined) throw new Error('no browser session');
    const page = await session.newPage();
    try {
      await page.goto(`${originOf('client-rendered-listing')}/results`, {
        waitUntil: 'networkidle2',
      });
      const html = await renderedHtml(page);
      const sellers = INVENTORY.slice(0, 6).map((entry) => entry.seller);
      expect(sellers.filter((seller) => !html.includes(seller))).toEqual([]);
      expect(html).toContain('<main>');
    } finally {
      await page.close();
    }
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

describe('@no-llm task-fidelity fixtures — remaining patterns', () => {
  const body = (name: SiteName, route: string): string => {
    const page = renderRoute(siteNamed(name), route);
    if (page === null) throw new Error(`${name} does not serve ${route}`);
    return page.body;
  };
  const truthValues = (): string[] =>
    truthRows().flatMap((row) => [
      row.fields.seller,
      row.fields.price,
      row.fields.exteriorColor,
      row.fields.interiorColor,
    ]);

  it('renders every route of every pattern deterministically, byte for byte', () => {
    const unstable = TASK_SITES.flatMap((site) =>
      site.routes
        .filter((route) => renderRoute(site, route)?.body !== renderRoute(site, route)?.body)
        .map((route) => `${site.name}${route}`),
    );
    expect(unstable).toEqual([]);
  });

  it('structured-listing: JSON-LD parses, and its Offer prices equal the truth prices', () => {
    const page = body('structured-listing', '/results');
    const script = /<script type="application\/ld\+json">\n([\s\S]*?)\n<\/script>/.exec(page);
    const list = JSON.parse(script?.[1] ?? 'null') as {
      readonly '@type': string;
      readonly itemListElement: readonly {
        readonly item: {
          readonly '@type': string;
          readonly offers: { readonly price: number; readonly seller: { readonly name: string } };
        };
      }[];
    };
    expect(list['@type']).toBe('ItemList');
    expect(list.itemListElement).toHaveLength(6);
    expect(list.itemListElement.every((element) => element.item['@type'] === 'Product')).toBe(true);
    expect(list.itemListElement.map((element) => element.item.offers.price)).toEqual(
      structuredPageItems(1).map((entry) => entry.price),
    );
    expect(list.itemListElement.map((element) => element.item.offers.seller.name)).toEqual(
      structuredPageItems(1).map((entry) => entry.seller),
    );
  });

  it('structured-listing: the visible body is a thin shell with no cards and no prices', () => {
    const visible = body('structured-listing', '/results').split('<body>')[1] ?? '';
    expect(visible).not.toContain('listing-card');
    expect(
      structuredPageItems(1).filter((entry) => visible.includes(formatAmount(entry.price))),
    ).toEqual([]);
  });

  it('client-rendered-listing: the HTTP shell is under 10 KB, scripted, rootless, and truth-free', () => {
    const shell = body('client-rendered-listing', '/results');
    expect(Buffer.byteLength(shell, 'utf8')).toBeLessThan(10_000);
    expect(shell).toMatch(/<script src="[^"]+"><\/script>/);
    expect(shell).not.toMatch(/<main|<article/);
    expect(INVENTORY.filter((entry) => shell.includes(entry.seller))).toEqual([]);
    expect(body('client-rendered-listing', '/assets/listing.js')).toContain(
      JSON.stringify(INVENTORY[0]?.seller),
    );
  });

  it('challenge-interstitial: both variants return 200 with the widget and no truth value', () => {
    const site = siteNamed('challenge-interstitial');
    for (const route of Object.values(CHALLENGE_PATHS)) {
      const page = renderRoute(site, route);
      expect(page?.status).toBe(200);
      expect(page?.body).toContain('data-sitekey=');
      expect(page?.body).toContain('name="captcha-token"');
      expect(page?.body).toContain('verify you are human');
      expect(truthValues().filter((value) => page?.body.includes(value))).toEqual([]);
    }
  });

  it('challenge-interstitial: the small variant escalates by today’s heuristic; large-main does not', () => {
    const small = body('challenge-interstitial', CHALLENGE_PATHS.small);
    const large = body('challenge-interstitial', CHALLENGE_PATHS['large-main']);
    expect(small.length).toBeLessThan(ESCALATION_SIZE_BYTES);
    expect(small).toContain('<script src=');
    expect(small).not.toMatch(/<main|<article/);
    expect(large.length).toBeGreaterThan(ESCALATION_SIZE_BYTES);
    expect(large).toContain('<main>');
  });

  it('article: about 1,500 words with a byline and a datePublished JSON-LD block', () => {
    const page = body('article', ARTICLE_PATH);
    const words = ARTICLE_SECTIONS.flatMap((section) => section.paragraphs)
      .join(' ')
      .split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(1_300);
    expect(words).toBeLessThanOrEqual(1_800);
    expect(page).toContain('"datePublished": "2026-03-14"');
    expect(page).toContain('<p class="byline">By <span rel="author">Mara Ellison</span>');
    expect(page).toContain('<article>');
    expect(page).toContain(ARTICLE_FACTS.coverageDays);
    expect(page).toContain(ARTICLE_FACTS.exampleCapacity);
  });

  it('multi-table: the answer cell is in table index 1, not 0', () => {
    const tables = body('multi-table', MULTI_TABLE_PATH).split('<table>').slice(1);
    expect(tables).toHaveLength(2);
    expect(tables[0]).not.toContain(MULTI_TABLE_ANSWER.cell);
    expect(tables[MULTI_TABLE_ANSWER.tableIndex]).toContain(
      `<td>${MULTI_TABLE_ANSWER.trim}</td><td>${MULTI_TABLE_ANSWER.drivetrain}</td><td>${MULTI_TABLE_ANSWER.cell}</td>`,
    );
  });
});

describe('@no-llm task-fidelity fixture census', () => {
  let siteTokens: RegExp;

  beforeAll(async () => {
    siteTokens = await loadSiteTokenPattern();
  });

  /** A real site token, derived from the shared list so no site name is typed here. */
  const firstSiteToken = (): string => siteTokens.source.split('|')[0] ?? '';

  const synthetic = (overrides: Partial<CensusSite> = {}): CensusSite => ({
    name: 'synthetic-site',
    host: 'synthetic-site.yantra.test',
    pattern: 'A synthetic pattern used only by the census self-test.',
    provenance: { gaps: ['G2'] },
    routes: ['/'],
    render: () => htmlPage('<!-- header: gaps G2 -->\n<p>plain body</p>'),
    ...overrides,
  });

  it('passes on the registered gallery', () => {
    expect(siteCensus(TASK_SITES, siteTokens)).toEqual([]);
  });

  it('finds every truth field where the truth says it renders', () => {
    expect(truthPlacementFindings()).toEqual([]);
  });

  it('finds no site token in any fixture string literal', async () => {
    const directory = join(dirname(fileURLToPath(import.meta.url)), 'task-fidelity', 'fixtures');
    const files = (await readdir(directory))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => join(directory, file));
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(sourceLiteralFindings(await fixtureSources(files), siteTokens)).toEqual([]);
  });

  it('fails on a synthetic site carrying a real-site token in a body string', () => {
    const token = firstSiteToken();
    const findings = siteCensus(
      [
        ...TASK_SITES,
        synthetic({
          render: () => htmlPage(`<!-- header: gaps G2 -->\n<p>compare with ${token}</p>`),
        }),
      ],
      siteTokens,
    );
    expect(findings.map((finding) => [finding.site, finding.problem])).toEqual([
      ['synthetic-site', `site token "${token}" outside the header comment`],
    ]);
  });

  it('fails on a duplicate pattern', () => {
    const findings = siteCensus(
      [...TASK_SITES, synthetic({ pattern: siteNamed('article').pattern })],
      siteTokens,
    );
    expect(findings).toEqual([
      { site: 'synthetic-site', problem: 'duplicate pattern (also used by article)' },
    ]);
  });

  it('fails when provenance leaks outside the header comment, or a page has no header', () => {
    expect(
      siteCensus(
        [synthetic({ render: () => htmlPage('<!-- header: gaps G2 -->\n<p>see G2</p>') })],
        siteTokens,
      ).map((finding) => finding.problem),
    ).toEqual(['provenance \\bG2\\b appears outside the header comment']);
    expect(
      siteCensus([synthetic({ render: () => htmlPage('<p>no header</p>') })], siteTokens).map(
        (finding) => finding.problem,
      ),
    ).toEqual(['page has no leading header comment', 'header comment omits provenance \\bG2\\b']);
  });

  it('flags a site token in a literal but not in a comment', () => {
    const token = firstSiteToken();
    const findings = sourceLiteralFindings(
      [
        {
          path: 'synthetic.ts',
          text: `// evidence: ${token} showed the defect\nconst host = 'www.${token}.example';\n`,
        },
      ],
      siteTokens,
    );
    expect(findings).toEqual([
      { site: 'synthetic.ts', problem: `site token "${token}" in a literal at line 2` },
    ]);
  });
});

describe('@no-llm task-fidelity scripted search', () => {
  const serps = [
    {
      match: 'teyra',
      results: [
        { url: `${originOf('faceted-listing')}/new/results`, title: 'Listing' },
        { url: `${originOf('article')}${ARTICLE_PATH}`, title: 'Article' },
        { url: `${originOf('multi-table')}${MULTI_TABLE_PATH}`, title: 'Specs' },
      ],
    },
  ];
  const search = (provider: ScriptedSearchProvider, query = 'norvale teyra', limit = 3) =>
    provider.search(query, { limit, signal: neverAborted() });

  it('serves the matching SERP with ranks, its own name as source, and at most `limit` hits', async () => {
    const provider = new ScriptedSearchProvider({ serps, name: 'brave', latencyMs: 0 });

    const results = await search(provider, 'NORVALE TEYRA prices', 2);

    expect(results).toEqual([
      {
        url: 'http://faceted-listing.yantra.test/new/results',
        title: 'Listing',
        snippet: null,
        source: 'brave',
        rank: 1,
        publishedAt: null,
      },
      {
        url: 'http://article.yantra.test/guides/home-backup-battery-sizing',
        title: 'Article',
        snippet: null,
        source: 'brave',
        rank: 2,
        publishedAt: null,
      },
    ]);
  });

  it('challenges the overlapping call of a concurrent pair with the real ScrapeSearchError', async () => {
    const provider = new ScriptedSearchProvider({
      serps,
      faults: [{ kind: 'challenge-on-concurrency' }],
    });

    const settled = await Promise.allSettled([search(provider), search(provider)]);

    expect(settled[0]?.status).toBe('fulfilled');
    expect(settled[1]?.status).toBe('rejected');
    const error = (settled[1] as PromiseRejectedResult).reason as unknown;
    expect(error).toBeInstanceOf(ScrapeSearchError);
    expect((error as ScrapeSearchError).context).toMatchObject({
      provider: 'duckduckgo',
      code: 'anomaly-challenge',
    });
    expect(provider.calls().map((call) => call.outcome)).toEqual(['ok', 'challenge']);
  });

  it('lets sequential calls through under challenge-on-concurrency', async () => {
    const provider = new ScriptedSearchProvider({
      serps,
      faults: [{ kind: 'challenge-on-concurrency' }],
    });

    await search(provider);
    await search(provider);

    expect(provider.calls().map((call) => call.outcome)).toEqual(['ok', 'ok']);
    expect(provider.peakConcurrency()).toBe(1);
  });

  it('throws empty and timeout on exactly the listed calls', async () => {
    const provider = new ScriptedSearchProvider({
      serps,
      latencyMs: 0,
      timeoutMs: 20,
      faults: [
        { kind: 'empty', onCall: [2] },
        { kind: 'timeout', onCall: [3] },
        { kind: 'challenge', onCall: [5] },
      ],
    });

    const outcomes: string[] = [];
    for (let call = 1; call <= 5; call += 1) {
      try {
        await search(provider);
        outcomes.push('ok');
      } catch (error) {
        expect(error).toBeInstanceOf(ScrapeSearchError);
        outcomes.push(String((error as ScrapeSearchError).context.code));
      }
    }

    expect(outcomes).toEqual(['ok', 'empty-results', 'timeout', 'ok', 'anomaly-challenge']);
    expect(provider.faultedCalls().map((call) => call.call)).toEqual([2, 3, 5]);
  });

  it('ends a timeout within 50 ms of the abort signal, as the transport does', async () => {
    const provider = new ScriptedSearchProvider({
      serps,
      timeoutMs: 10_000,
      faults: [{ kind: 'timeout', onCall: [1] }],
    });
    const controller = new AbortController();
    const started = performance.now();
    const pending = provider.search('norvale teyra', { limit: 3, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ context: { code: 'aborted' } });

    expect(performance.now() - started).toBeLessThan(20 + 50);
    expect(provider.calls()[0]?.outcome).toBe('aborted');
  });

  it('answers `limit: 0` with nothing and never consults the table', async () => {
    const provider = new ScriptedSearchProvider({
      serps,
      faults: [{ kind: 'challenge', onCall: [1] }],
    });

    await expect(search(provider, 'norvale teyra', 0)).resolves.toEqual([]);

    expect(provider.calls()[0]?.outcome).toBe('discovery');
  });

  it('records exact peak concurrency per call and overall, on the injected clock', async () => {
    let tick = 0;
    const provider = new ScriptedSearchProvider({ serps, latencyMs: 15, now: () => (tick += 1) });

    await Promise.all([search(provider), search(provider), search(provider)]);
    await search(provider);

    const calls = provider.calls();
    expect(calls.map((call) => call.peakConcurrency)).toEqual([3, 3, 3, 1]);
    expect(provider.peakConcurrency()).toBe(3);
    expect(calls.every((call) => call.endedAt !== null && call.endedAt > call.startedAt)).toBe(
      true,
    );
    expect(calls.map((call) => call.startedAt)).toEqual([1, 2, 3, calls[3]?.startedAt]);
  });

  it('answers an unmatched query with nothing, without throwing or touching the network', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider = new ScriptedSearchProvider({ serps, latencyMs: 0 });

    await expect(search(provider, 'something else entirely')).resolves.toEqual([]);

    expect(provider.calls()[0]?.outcome).toBe('unmatched');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('wires into the run as an ok() search-provider resolution', async () => {
    const provider = new ScriptedSearchProvider({ serps });
    const resolved = await scriptedSearchLeaf(provider)();
    expect(resolved.isOk && resolved.value).toBe(provider);
  });
});
