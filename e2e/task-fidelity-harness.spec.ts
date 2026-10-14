/**
 * @no-llm task-fidelity harness self-tests and census (FEAT-049).
 *
 * The harness is measurement infrastructure: a fixture that drifts from its
 * truth, a host mapping that leaks, or a scripted provider that fakes an error
 * class would make every score it produces meaningless. These tests pin each
 * piece of the harness against the production code it drives.
 */

import { X509Certificate, createPublicKey } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentAuthUnavailableError, DEFAULT_AGENT_BUDGETS, PROMPT_VERSION } from '@yantra/agent';
import {
  HttpFetcher,
  LocalBrowserProvider,
  LocalProfileStore,
  ScrapeSearchError,
  resetPathCache,
  type BrowserSession,
} from '@yantra/core';
import { assertRuntimeLinesAreSafe } from '@yantra/test-helpers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScriptStep } from './task-fidelity/agent/scripted-provider.js';
import {
  EvalUsageError,
  MODEL_FLAGS,
  evalFailure,
  evaluate,
  parseEvalArgs,
} from './task-fidelity/eval.js';
import {
  atLeast,
  atMost,
  count,
  equals,
  evaluateExpectation,
  everyLine,
  excludesAll,
  expectationCensus,
  expectationTestName,
  includesAll,
  matchesShape,
  show,
  type Expectation,
  type Matcher,
  type Owner,
} from './task-fidelity/expectations.js';
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
import {
  serveTaskSites,
  type RequestLogEntry,
  type TaskSiteServer,
} from './task-fidelity/fixtures/server.js';
import {
  SITE_NAMES,
  TASK_SITES,
  originOf,
  renderRoute,
  siteNamed,
  type SiteName,
} from './task-fidelity/fixtures/sites.js';
import { structuredPageItems } from './task-fidelity/fixtures/structured-listing.js';
import { fixtureTlsIdentity } from './task-fidelity/fixtures/tls.js';
import {
  parseJsonl,
  readArtifacts,
  runScenario,
  type ScenarioRun,
} from './task-fidelity/runner.js';
import type { Scenario } from './task-fidelity/scenario.js';
import {
  HELPER_MODULES,
  SCENARIOS,
  scenarioNamed,
  scenariosFor,
} from './task-fidelity/scenarios/index.js';
import { listingTable } from './task-fidelity/scenarios/listing-table.js';
import { renderScorecardMarkdown } from './task-fidelity/score/render-md.js';
import {
  BaselineSchema,
  ScoreCardSchema,
  baselineOf,
  type ScoreCard,
} from './task-fidelity/score/scorecard-schema.js';
import {
  deliveredUnits,
  median,
  normalize,
  scoreRun,
  stability,
} from './task-fidelity/score/scorer.js';
import {
  brief,
  detailText,
  fetchAudit,
  motivatingRun,
  oracleRun,
  stableScorecard,
  syntheticRun,
} from './task-fidelity/score/synthetic-runs.js';
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

  it('serves an https fixture URL through the HTTP tier, and still refuses off-fixture https', async () => {
    server.reset();
    const fetcher = new HttpFetcher({ requestFn: mappedRequestFn(server.port) });
    const doc = await fetcher.fetch('https://faceted-listing.yantra.test/', {
      timeoutMs: 5_000,
      signal: neverAborted(),
    });
    expect(doc.statusCode).toBe(200);
    expect(doc.html).toContain('<a href="/new/results">Shop new</a>');
    expect(server.requests()).toEqual([
      expect.objectContaining({ host: 'faceted-listing.yantra.test', path: '/', scheme: 'http' }),
    ]);
    await expect(
      mappedRequestFn(server.port)('https://example.org/', { method: 'GET' }),
    ).rejects.toBeInstanceOf(HarnessEgressError);
  });

  it('generates one valid self-signed certificate for *.yantra.test per process', () => {
    const identity = fixtureTlsIdentity();
    const certificate = new X509Certificate(identity.cert);

    expect(fixtureTlsIdentity()).toBe(identity);
    expect(certificate.subjectAltName).toBe('DNS:*.yantra.test, DNS:yantra.test');
    expect(certificate.checkIssued(certificate)).toBe(true);
    expect(certificate.verify(createPublicKey(identity.key))).toBe(true);
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

  it('serves a fixture host over https with the throwaway certificate, and keeps http as http', async () => {
    if (session === undefined) throw new Error('no browser session');
    server.reset();
    const page = await session.newPage();
    try {
      await page.goto(`https://faceted-listing.yantra.test/new/results`, { waitUntil: 'load' });
      expect(page.url()).toBe('https://faceted-listing.yantra.test/new/results');
      expect(await renderedHtml(page)).toContain('<h1>Norvale Teyra for sale near you</h1>');
      await page.goto(`${originOf('faceted-listing')}/`, { waitUntil: 'load' });
      // `.test` hosts are never auto-upgraded, so an http fixture stays http.
      expect(page.url()).toBe('http://faceted-listing.yantra.test/');
    } finally {
      await page.close();
    }
    expect(
      server
        .requests()
        .filter((entry) => entry.path !== '/favicon.ico')
        .map((entry) => [entry.scheme, entry.path]),
    ).toEqual([
      ['https', '/new/results'],
      ['http', '/'],
    ]);
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

  it('challenge-interstitial: challenges every page, as a bot wall does', () => {
    const site = siteNamed('challenge-interstitial');
    for (const route of ['/', '/sitemap.xml', '/new/results?drivetrain=AWD']) {
      const page = renderRoute(site, route);
      expect(page?.status).toBe(200);
      expect(page?.body).toContain('data-sitekey=');
    }
  });

  it('serves a home page on every non-challenge site that links to its main pages', () => {
    const missing = TASK_SITES.filter((site) => site.name !== 'challenge-interstitial')
      .filter((site) => {
        const home = renderRoute(site, '/');
        return home?.status !== 200 || !home.body.includes('<a href="/');
      })
      .map((site) => site.name);
    expect(missing).toEqual([]);
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

describe('@no-llm task-fidelity runner', () => {
  let runRoot: string;

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-runner-'));
  });

  afterAll(async () => {
    if (runRoot) await rm(runRoot, { recursive: true, force: true });
  });

  const article = `${originOf('article')}${ARTICLE_PATH}`;
  const publishStep: ScriptStep = {
    kind: 'call',
    tool: 'result_publish',
    params: { brief: { title: 'Runner self-test', overview: 'The runner self-test published.' } },
  };
  const scenario = (overrides: Partial<Scenario>): Scenario => ({
    id: 'runner-self-test',
    sites: ['article'],
    command: 'research',
    goal: `Summarize the guide at ${article}`,
    contract: { deliverable: 'answer', requiredFields: [], filters: [], requiredSources: [] },
    userLocation: null,
    serps: [{ match: 'battery', results: [{ url: article, title: 'Guide' }] }],
    script: [],
    expectations: [],
    tiers: ['deterministic'],
    truth: () => [],
    ...overrides,
  });
  const run = (overrides: Partial<Scenario>): Promise<ScenarioRun> =>
    runScenario(scenario(overrides), {
      mode: 'deterministic',
      runRoot,
      runtimeLogScanner: assertRuntimeLinesAreSafe,
    });

  it('publishes a two-step script and audits it with the Pi seam’s own projection', async () => {
    const result = await run({
      script: [{ kind: 'call', tool: 'web_fetch', params: { url: article } }, publishStep],
    });

    expect(result.outcome.kind).toBe('published');
    const lines = (result.artifacts.toolCalls?.lines ?? []) as {
      readonly phase: string;
      readonly tool: string;
      readonly output_sanitized: unknown;
    }[];
    expect(lines.map((line) => [line.tool, line.phase])).toEqual([
      ['web_fetch', 'start'],
      ['web_fetch', 'end'],
      ['result_publish', 'start'],
      ['result_publish', 'end'],
    ]);
    // `audit` is `auditProjectionOf(result)`, computed by the scripted agent
    // from the result it received: the recorder persisted exactly that.
    expect(
      lines.filter((line) => line.phase === 'end').map((line) => line.output_sanitized),
    ).toEqual(result.toolResults.map((received) => received.audit));
    expect(result.artifacts.toolCalls?.unparseable).toEqual([]);
    expect(result.requests.map((entry) => `${entry.host}${entry.path}`)).toEqual([
      'article.yantra.test/guides/home-backup-battery-sizing',
    ]);
    expect(result.egress).toEqual([]);
    expect(result.canaryHits).toEqual([]);
    expect(result.runtimeLogFindings).toEqual([]);
  }, 60_000);

  it('issues a parallel step concurrently: the two searches overlap in the call log', async () => {
    const result = await run({
      // A keyed API provider: FEAT-050's politeness gate lets it take two
      // searches at once, so the overlap measures the runner, not the gate.
      // (A scraped provider is serialized; `search-concurrency` pins that.)
      searchProviderName: 'tavily',
      script: [
        {
          kind: 'parallel',
          steps: [
            { kind: 'call', tool: 'web_search', params: { query: 'battery sizing', limit: 1 } },
            { kind: 'call', tool: 'web_search', params: { query: 'battery backup', limit: 1 } },
          ],
        },
        publishStep,
      ],
    });

    const [first, second] = result.searchCalls;
    expect(result.searchCalls).toHaveLength(2);
    expect(second?.startedAt ?? Infinity).toBeLessThan(first?.endedAt ?? -Infinity);
    expect(result.searchPeakConcurrency).toBe(2);
  }, 60_000);

  it('records a resolver that finds nothing as unreachable and makes no call', async () => {
    const result = await run({
      script: [
        {
          kind: 'call',
          tool: 'web_fetch',
          label: 'follow first record',
          params: (ctx) => {
            const record = ctx.recordsFrom()[0];
            return record?.url ? { url: record.url } : null;
          },
        },
        publishStep,
      ],
    });

    expect(result.unreachable).toEqual(['follow first record']);
    expect(result.toolResults.map((received) => received.tool)).toEqual(['result_publish']);
    expect(result.requests).toEqual([]);
  }, 60_000);

  it('leaves the developer’s home untouched, and takes the catalog from the scenario alone', async () => {
    const developerHome = await mkdtemp(join(tmpdir(), 'yantra-developer-home-'));
    await writeFile(join(developerHome, 'canary.yaml'), 'untouched: true\n', 'utf8');
    const previousHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = developerHome;
    try {
      // Browsing is on by default, so only the scenario's `browse: false` can
      // remove the browser tools; nothing in the environment can (FEAT-052).
      const result = await run({
        browse: false,
        script: [{ kind: 'call', tool: 'browser_navigate', params: { url: article } }, publishStep],
      });

      expect(result.unreachable).toEqual(['browser_navigate (tool not registered)']);
      expect(result.registeredTools.some((name) => name.startsWith('browser_'))).toBe(false);
      expect(result.browserLaunches).toBe(0);
      expect(process.env.YANTRA_HOME).toBe(developerHome);
      expect(await readdir(developerHome)).toEqual(['canary.yaml']);
      expect(await readFile(join(developerHome, 'canary.yaml'), 'utf8')).toBe('untouched: true\n');
    } finally {
      if (previousHome === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = previousHome;
      resetPathCache();
      await rm(developerHome, { recursive: true, force: true });
    }
  }, 60_000);

  it('gives a research scenario the read-only browser by default', async () => {
    const result = await run({ script: [publishStep] });

    expect(result.registeredTools).toEqual(
      expect.arrayContaining(['browser_extract', 'browser_navigate', 'browser_observe']),
    );
    expect(result.registeredTools).not.toContain('browser_click');
    expect(result.prompt).toContain('Scope: web search, page reading, and read-only browsing');
  }, 60_000);

  it.each(['web_fetch', 'browser_extract'] as const)(
    'scores an attributed %s publication whose values exist only in structured evidence',
    async (tool) => {
      const base = scenarioNamed('listing-structured');
      const url = `${originOf('structured-listing')}/results`;
      const scripted: Scenario = {
        ...base,
        id: `runner-attributed-${tool}`,
        script: [
          ...(tool === 'browser_extract'
            ? [{ kind: 'call', tool: 'browser_navigate', params: { url } } as const]
            : []),
          { kind: 'call', tool, params: tool === 'web_fetch' ? { url } : { kind: 'structured' } },
          {
            kind: 'call',
            tool: 'result_publish',
            params: (ctx) => {
              const payload = ctx.last(tool)?.model as
                | {
                    source_id?: string;
                    structured?: { type: string; props: Record<string, unknown> }[];
                  }
                | undefined;
              const products = payload?.structured?.filter((entry) => entry.type === 'Product');
              if (payload?.source_id === undefined || products === undefined) return null;
              return {
                brief: {
                  title: 'Listings',
                  overview: '',
                  table: {
                    columns: ['Item', 'Seller', 'Price'],
                    rows: products.map((entry) => [
                      entry.props.name,
                      entry.props['offers.seller.name'],
                      formatAmount(Number(entry.props['offers.price'])),
                    ]),
                    row_sources: products.map(() => [payload.source_id]),
                  },
                },
              };
            },
          },
        ],
      };
      const result = await runScenario(scripted, { mode: 'deterministic', runRoot });
      expect(result.outcome.kind).toBe('published');
      expect(result.unreachable).toEqual([]);
      const score = scoreRun(result, scripted, scripted.truth());
      expect(score.citation_validity).toMatchObject({ numerator: 12, denominator: 12 });
      expect(score.field_coverage).toMatchObject({ numerator: 12, denominator: 12 });
      if (tool === 'browser_extract')
        expect(
          result.toolResults.some(
            (entry) => entry.tool === 'web_fetch' || entry.tool === 'web_search',
          ),
        ).toBe(false);
    },
    60_000,
  );

  it('reads a missing artifact as null and reports unparseable JSONL lines by number', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'yantra-empty-run-'));
    try {
      await writeFile(join(empty, 'tool-calls.jsonl'), '{"a":1}\nnot json\n\n{"b":2}\n', 'utf8');
      await writeFile(join(empty, 'usage.json'), '{ broken', 'utf8');

      const artifacts = await readArtifacts(empty);

      expect(artifacts.manifest).toBeNull();
      expect(artifacts.brief).toBeNull();
      expect(artifacts.runHealth).toBeNull();
      expect(artifacts.report).toBeNull();
      expect(artifacts.runtime).toBeNull();
      expect(artifacts.usage).toBeNull();
      expect(artifacts.unparseableJson).toEqual(['usage.json']);
      expect(artifacts.toolCalls).toEqual({ lines: [{ a: 1 }, { b: 2 }], unparseable: [2] });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
  it('loads only valid referenced capture IDs from the owning run directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yantra-capture-score-'));
    const ref = 'cap-01ARZ3NDEKTSV4RRFFQ69G5FAV';
    try {
      await mkdir(join(dir, 'captures'));
      await writeFile(join(dir, 'captures', `${ref}.txt`), 'Price 45000', 'utf8');
      await writeFile(
        join(dir, 'tool-calls.jsonl'),
        JSON.stringify({
          phase: 'end',
          output_sanitized: {
            content: [{ text: JSON.stringify({ capture_ref: ref }) }],
            details: { analysis_capture_ref: '../../unowned' },
          },
        }) + '\n',
        'utf8',
      );
      expect((await readArtifacts(dir)).captures).toEqual({ [ref]: 'Price 45000' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a runtime-log scanner refusal as a finding instead of throwing it', async () => {
    const result = await runScenario(scenario({ script: [publishStep] }), {
      mode: 'deterministic',
      runRoot,
      runtimeLogScanner: () => {
        throw new Error('runtime.jsonl line 1 carries forbidden key "url"');
      },
    });

    expect(result.outcome.kind).toBe('published');
    expect(result.runtimeLogFindings).toEqual(['runtime.jsonl line 1 carries forbidden key "url"']);
  }, 60_000);

  it('parses a clean JSONL file with no unparseable lines', () => {
    expect(parseJsonl('{"event":"x"}\n{"event":"y"}\n')).toEqual({
      lines: [{ event: 'x' }, { event: 'y' }],
      unparseable: [],
    });
  });
});

describe('@no-llm task-fidelity expectations', () => {
  /** A stand-in run: measures in these tests read only `requests`. */
  const runWith = (requests: number): ScenarioRun =>
    ({ requests: Array.from({ length: requests }, (_, index) => index) }) as unknown as ScenarioRun;
  const fetchesOfResults: Pick<Expectation, 'id' | 'measure' | 'note'> = {
    id: 'one-request-per-url',
    measure: (run) => run.requests.length,
    note: 'G5: the results page is fetched once.',
  };
  const pendingFifty = new Set<Owner>(['FEAT-050']);

  it('passes a pending expectation whose baseline holds and whose target fails', () => {
    const verdict = evaluateExpectation(
      runWith(3),
      { ...fetchesOfResults, owner: 'FEAT-050', target: equals(1), baseline: equals(3) },
      pendingFifty,
    );
    expect(verdict).toEqual({
      pass: true,
      asserted: 'baseline',
      message: 'one-request-per-url (baseline for FEAT-050): expected equals 3; measured 3',
    });
  });

  it('fails a pending expectation whose target already holds, naming the owner to flip', () => {
    const verdict = evaluateExpectation(
      runWith(1),
      { ...fetchesOfResults, owner: 'FEAT-050', target: equals(1), baseline: atLeast(1) },
      pendingFifty,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toBe(
      "one-request-per-url: FEAT-050's target already holds (equals 1); remove FEAT-050 from " +
        'PENDING_OWNERS and delete this baseline.',
    );
  });

  it('fails a pending expectation whose baseline no longer characterizes the run', () => {
    const verdict = evaluateExpectation(
      runWith(2),
      { ...fetchesOfResults, owner: 'FEAT-050', target: equals(1), baseline: equals(3) },
      pendingFifty,
    );
    expect(verdict).toMatchObject({ pass: false, asserted: 'baseline' });
    expect(verdict.message).toContain('measured 2');
  });

  it('switches to the target once the owner leaves the pending set', () => {
    const expectation: Expectation = {
      ...fetchesOfResults,
      owner: 'FEAT-050',
      target: equals(1),
      baseline: equals(3),
    };
    expect(evaluateExpectation(runWith(3), expectation, pendingFifty).asserted).toBe('baseline');

    const landed = evaluateExpectation(runWith(3), expectation, new Set<Owner>());
    expect(landed).toEqual({
      pass: false,
      asserted: 'target',
      message: 'one-request-per-url: expected equals 1; measured 3',
    });
    expect(evaluateExpectation(runWith(1), expectation, new Set<Owner>()).pass).toBe(true);
  });

  it('asserts the target of a current expectation regardless of the pending set', () => {
    const expectation: Expectation = { ...fetchesOfResults, owner: 'current', target: atMost(2) };
    expect(evaluateExpectation(runWith(2), expectation, pendingFifty).pass).toBe(true);
    expect(evaluateExpectation(runWith(3), expectation, pendingFifty).pass).toBe(false);
  });

  it('fails loudly when a measure throws, instead of passing a baseline vacuously', () => {
    const verdict = evaluateExpectation(
      runWith(0),
      {
        ...fetchesOfResults,
        owner: 'FEAT-050',
        measure: () => {
          throw new Error('brief.json is missing');
        },
        target: equals(1),
        baseline: equals(null),
      },
      pendingFifty,
    );
    expect(verdict).toEqual({
      pass: false,
      asserted: 'baseline',
      message: 'one-request-per-url: the measure threw: brief.json is missing',
    });
  });

  it('fails a pending expectation that has no baseline', () => {
    const verdict = evaluateExpectation(
      runWith(3),
      { ...fetchesOfResults, owner: 'FEAT-050', target: equals(1) },
      pendingFifty,
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.message).toContain('needs a baseline');
  });

  it('includes the measured value in every matcher’s failure message', () => {
    const cases: readonly [Matcher, unknown, string][] = [
      [equals(1), 2, 'expected equals 1; measured 2'],
      [atLeast(3), 2, 'expected a number ≥ 3; measured 2'],
      [atMost(1), 2, 'expected a number ≤ 1; measured 2'],
      [includesAll(['a', 'b']), ['a'], 'expected includes all of ["a","b"]; measured ["a"]'],
      [excludesAll(['a']), ['a', 'c'], 'expected excludes all of ["a"]; measured ["a","c"]'],
      [
        matchesShape({ kind: 'blocked' }),
        { kind: 'ok', n: 1 },
        'expected matches shape {"kind":"blocked"}; measured {"kind":"ok","n":1}',
      ],
      [
        everyLine('parses', (line) => line !== null),
        [1, null],
        'expected every line parses; measured [1,null]',
      ],
      [count(2), ['x'], 'expected a list whose length equals 2; measured 1: ["x"]'],
    ];
    expect(cases.map(([candidate, value]) => candidate.test(value))).toEqual(
      cases.map(([, , message]) => ({ pass: false, message })),
    );
  });

  it('applies each matcher’s semantics', () => {
    expect(equals({ a: [1, { b: 2 }] }).test({ a: [1, { b: 2 }] }).pass).toBe(true);
    expect(equals({ a: 1 }).test({ a: 1, b: 2 }).pass).toBe(false);
    expect(includesAll(['seller']).test('a seller line').pass).toBe(true);
    expect(excludesAll(['S1']).test('S2 S3').pass).toBe(true);
    expect(matchesShape({ a: { b: 1 } }).test({ a: { b: 1, c: 2 }, d: 3 }).pass).toBe(true);
    expect(matchesShape([{ kind: 'facet' }]).test([{ kind: 'facet', url: 'x' }]).pass).toBe(true);
    expect(everyLine('is even', (line) => (line as number) % 2 === 0).test([]).pass).toBe(true);
    expect(everyLine('is even', () => true).test('not a list').pass).toBe(false);
    expect(count(atLeast(2)).test([1, 2, 3]).pass).toBe(true);
    expect(show('x'.repeat(400))).toMatch(/… \(402 chars\)$/);
    expect(show(undefined)).toBe('<undefined>');
  });

  describe('census', () => {
    const current: Expectation = {
      id: 'audit-parses',
      owner: 'current',
      measure: () => 0,
      target: equals(0),
      note: 'Every audit line parses.',
    };
    const catalogue = (
      expectations: readonly Expectation[],
    ): { readonly id: string; readonly expectations: readonly Expectation[] }[] => [
      { id: 'synthetic', expectations: [current, ...expectations] },
    ];
    const pendingFiftyExpectation: Expectation = {
      ...fetchesOfResults,
      owner: 'FEAT-050',
      target: equals(1),
      baseline: equals(3),
    };

    it('passes a well-formed catalogue', () => {
      expect(expectationCensus(catalogue([pendingFiftyExpectation]), pendingFifty)).toEqual([]);
    });

    it('fails a landed owner that still carries a baseline, naming the expectation', () => {
      expect(expectationCensus(catalogue([pendingFiftyExpectation]), new Set<Owner>())).toEqual([
        'synthetic › one-request-per-url: FEAT-050 has landed; delete this leftover baseline',
      ]);
    });

    it('fails a current baseline, a missing pending baseline, a blank note, and a duplicate id', () => {
      const findings = expectationCensus(
        catalogue([
          { ...current, id: 'current-with-baseline', baseline: equals(0) },
          { ...fetchesOfResults, owner: 'FEAT-050', target: equals(1) },
          { ...pendingFiftyExpectation, id: 'blank-note', note: ' ' },
          { ...current },
        ]),
        pendingFifty,
      );
      expect(findings).toEqual([
        'synthetic › current-with-baseline: a "current" expectation must not carry a baseline',
        'synthetic › one-request-per-url: pending owner FEAT-050 needs a baseline',
        'synthetic › blank-note: empty note',
        'synthetic › audit-parses: duplicate expectation id',
      ]);
    });

    it('fails a pending owner with no baseline anywhere, and an all-baseline scenario', () => {
      expect(
        expectationCensus(
          [{ id: 'all-baseline', expectations: [pendingFiftyExpectation] }],
          new Set<Owner>(['FEAT-050', 'FEAT-051']),
        ),
      ).toEqual([
        'all-baseline: no "current" expectation — the scenario is all-baseline',
        'pending owner FEAT-051 has no baseline anywhere in the catalogue',
      ]);
    });

    it('fails an undeclared owner', () => {
      expect(
        expectationCensus(
          catalogue([{ ...current, id: 'stray', owner: 'FEAT-099' as Owner }]),
          new Set<Owner>(),
        ),
      ).toEqual(['synthetic › stray: undeclared owner "FEAT-099"']);
    });

    it('names each expectation’s test as scenario › owner › id', () => {
      expect(expectationTestName('listing-table', current)).toBe(
        'listing-table › current › audit-parses',
      );
    });
  });
});

describe('@no-llm task-fidelity scenario catalogue census', () => {
  const scenariosDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    'task-fidelity',
    'scenarios',
  );

  it('passes the expectation census: owners, baselines, notes, and a current expectation each', () => {
    expect(expectationCensus(scenariosFor('deterministic'))).toEqual([]);
  });

  it('gives every scenario a unique id', () => {
    const ids = SCENARIOS.map((scenario) => scenario.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('registers every scenario file in the index, and nothing the directory lacks', async () => {
    const files = (await readdir(scenariosDirectory))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.replace(/\.ts$/, ''))
      .filter((module) => !HELPER_MODULES.includes(module))
      .sort();
    const index = await readFile(join(scenariosDirectory, 'index.ts'), 'utf8');
    const imported = [...index.matchAll(/from '\.\/([\w-]+)\.js';/g)]
      .map((match) => match[1] ?? '')
      .filter((module) => !HELPER_MODULES.includes(module))
      .sort();

    expect(imported).toEqual(files);
    expect(SCENARIOS).toHaveLength(files.length);
  });

  it('keeps every deterministic scenario hermetic: registered sites, fixture-only SERPs', () => {
    const problems = SCENARIOS.flatMap((scenario) => [
      ...scenario.sites
        .filter((name) => !SITE_NAMES.includes(name))
        .map((name) => `${scenario.id}: unknown site ${name}`),
      ...scenario.serps.flatMap((entry) =>
        entry.results
          .filter((hit) => !new URL(hit.url).hostname.endsWith('.yantra.test'))
          .map((hit) => `${scenario.id}: SERP points off-fixture at ${hit.url}`),
      ),
      ...(scenario.tiers.includes('deterministic') && scenario.script.length === 0
        ? [`${scenario.id}: a deterministic scenario needs a script`]
        : []),
    ]);
    expect(problems).toEqual([]);
  });

  it('looks scenarios up by id and filters them by tier', () => {
    expect(scenarioNamed('listing-table').id).toBe('listing-table');
    expect(() => scenarioNamed('no-such-scenario')).toThrow(/no task-fidelity scenario/);
    expect(
      scenariosFor('deterministic').every((scenario) => scenario.tiers.includes('deterministic')),
    ).toBe(true);
  });
});

describe('@no-llm task-fidelity scorer', () => {
  const score = (run: ScenarioRun) => scoreRun(run, listingTable, truthRows());
  const listing = 'http://faceted-listing.yantra.test/new/results';
  const rowById = (id: string) => {
    const row = truthRows().find((candidate) => candidate.itemId === id);
    if (row === undefined) throw new Error(`no truth row ${id}`);
    return row;
  };
  const tableRun = (
    ids: readonly string[],
    options: { readonly sourceFor?: (id: string) => string; readonly evidence?: boolean } = {},
  ): ScenarioRun => {
    const rows = ids.map(rowById);
    const sourceFor = options.sourceFor ?? ((id: string) => rowById(id).detailUrl);
    return syntheticRun({
      brief: brief({
        title: 'Listings',
        overview: 'Listings from the requested site.',
        comparison: {
          columns: ['Seller', 'Price', 'Exterior color', 'Interior color'],
          rows: rows.map((row) => [
            row.fields.seller,
            row.fields.price,
            row.fields.exteriorColor,
            row.fields.interiorColor,
          ]),
          row_citations: rows.map((_, index) => [index + 1]),
        },
        sources: ids.map((id) => ({ url: sourceFor(id) })),
      }),
      toolCalls:
        options.evidence === false
          ? []
          : rows.map((row, index) => fetchAudit(sourceFor(ids[index] ?? ''), detailText(row))),
    });
  };
  it.each(['structured', 'records', 'fields', 'tables', 'capture', 'browser'])(
    'scores cited %s evidence absent from visible shell text',
    (kind) => {
      const row = rowById('itm-08');
      const url = row.detailUrl;
      const values = [
        row.fields.seller,
        row.fields.price,
        row.fields.exteriorColor,
        row.fields.interiorColor,
      ];
      const ref = 'cap-01ARZ3NDEKTSV4RRFFQ69G5FAV';
      const data: Record<string, unknown> = {
        url,
        text: 'Browse inventory',
        ...(kind === 'structured' ? { structured: [{ type: 'Product', props: row.fields }] } : {}),
        ...(kind === 'records'
          ? { records: [{ id: 'S1#r1', title: row.fields.title, text: values }] }
          : {}),
        ...(kind === 'fields' ? { fields: row.fields } : {}),
        ...(kind === 'tables'
          ? { tables: [{ headers: ['seller', 'price', 'exterior', 'interior'], rows: [values] }] }
          : {}),
        ...(kind === 'capture' ? { capture_ref: ref } : {}),
        ...(kind === 'browser' ? { text: detailText(row), source_id: 'S1' } : {}),
      };
      const oracle = tableRun(['itm-08'], { evidence: false });
      const run = {
        ...oracle,
        artifacts: {
          ...oracle.artifacts,
          toolCalls: {
            lines: [
              {
                phase: 'end',
                tool: kind === 'browser' ? 'browser_extract' : 'web_fetch',
                output_sanitized: {
                  content: [{ type: 'text', text: JSON.stringify(data) }],
                },
              },
            ],
            unparseable: [],
          },
          captures: { [ref]: detailText(row) },
        },
      };
      expect(score(run).citation_validity).toMatchObject({
        value: 1,
        numerator: 4,
        denominator: 4,
      });
    },
  );
  it.each(['AWD offers', 'Listings'])(
    'does not treat verified FWD as verification of AWD under title %s',
    (title) => {
      const original = tableRun(['itm-08']);
      const run = {
        ...original,
        artifacts: {
          ...original.artifacts,
          brief: {
            ...(original.artifacts.brief as Record<string, unknown>),
            title,
            constraints: [{ name: 'drivetrain', value: 'FWD', status: 'verified' }],
          },
        },
      };
      expect(score(run).constraint_fidelity).toMatchObject({ value: 0 });
      expect(score(run).constraint_fidelity.detail).toContain(
        'verifies drivetrain=FWD instead of required AWD',
      );
    },
  );

  it('scores the motivating run near zero, with one asserted-unverified constraint and 0/12 honesty', () => {
    const scores = score(motivatingRun());

    expect(scores.field_coverage).toMatchObject({ value: 0.1, numerator: 2, denominator: 20 });
    expect(scores.delivered_row_keys).toEqual(['itm-01']);
    expect(scores.constraint_fidelity).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(scores.constraint_fidelity.detail).toEqual([
      'asserts drivetrain=AWD in the title or overview without a verified constraint',
    ]);
    expect(scores.citation_validity).toMatchObject({ value: null, numerator: 0, denominator: 0 });
    expect(scores.honesty).toMatchObject({ value: 0, numerator: 0, denominator: 12 });
    expect(scores.honesty.detail).toContain(
      'heuristic: the document asserts a site-side cause no injected fault supports',
    );
    expect(scores.source_fidelity).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(scores.cost).toMatchObject({
      turns: 15,
      input_tokens: 135_000,
      output_tokens: 6_000,
      navigations: 30,
      browser_launches: 48,
    });
  });

  it('scores an oracle Brief at full coverage, fidelity, and validity', () => {
    const scores = score(oracleRun());

    expect(scores.field_coverage).toMatchObject({ value: 1, numerator: 20, denominator: 20 });
    expect(scores.constraint_fidelity).toMatchObject({ value: 1, detail: [] });
    expect(scores.source_fidelity).toMatchObject({ value: 1, numerator: 5, denominator: 5 });
    expect(scores.citation_validity).toMatchObject({ value: 1, numerator: 20, denominator: 20 });
    expect(scores.delivered_row_keys).toEqual(['itm-08', 'itm-03', 'itm-13', 'itm-01', 'itm-10']);
    expect(scores.honesty).toMatchObject({ value: null, denominator: 0 });
  });

  it('counts a delivered FWD row as a constraint violation', () => {
    const scores = score(tableRun(['itm-08', 'itm-02']));

    expect(scores.constraint_fidelity).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(scores.constraint_fidelity.detail).toEqual([
      'itm-02 violates drivetrain=AWD (truth: FWD)',
    ]);
  });

  it('lowers source fidelity for a row cited to an off-contract host', () => {
    const scores = score(
      tableRun(['itm-08', 'itm-03'], {
        sourceFor: (id) =>
          id === 'itm-03' ? 'http://structured-listing.yantra.test/results' : rowById(id).detailUrl,
      }),
    );

    expect(scores.source_fidelity).toMatchObject({ value: 0.5, numerator: 1, denominator: 2 });
    expect(scores.source_fidelity.detail).toEqual([
      'itm-03: off-contract structured-listing.yantra.test',
    ]);
  });

  it('counts a citation whose source lacks the value as invalid', () => {
    const scores = score(tableRun(['itm-08'], { evidence: false }));

    expect(scores.citation_validity).toMatchObject({ value: 0, numerator: 0, denominator: 4 });
    expect(scores.citation_validity.detail).toContain(
      `itm-08.exteriorColor = "${rowById('itm-08').fields.exteriorColor}" is not in cited [1]`,
    );
  });

  it('excludes rows in an alternatives section from the answer', () => {
    const offContract = rowById('itm-03');
    const run = syntheticRun({
      brief: brief({
        title: 'Listings',
        overview: 'Listings.',
        sections: [
          {
            heading: 'Alternatives',
            kind: 'alternatives',
            body_md: `- ${offContract.fields.seller} at ${offContract.fields.price}`,
          },
        ],
      }),
    });
    expect(score(run).delivered_row_keys).toEqual([]);
  });

  it('matches a row by title and seller only when that pair is unique in the truth', () => {
    const unique = rowById('itm-04');
    const run = syntheticRun({
      brief: brief({
        title: 'Listings',
        overview: 'Listings.',
        findings: [
          { text: `${unique.key.title} from ${unique.fields.seller}` },
          { text: `${rowById('itm-01').key.title} from Lakeside Motors` },
        ],
      }),
    });
    const scores = score(run);
    expect(scores.delivered_row_keys).toEqual(['itm-04']);
    expect(scores.field_coverage.detail).toContain(
      'ambiguous: "New 2026 Norvale Teyra Summit" by Lakeside Motors names 2 items without a price',
    );
  });

  it('rates three identical runs fully stable and three disjoint runs not at all', () => {
    const top = ['itm-08', 'itm-03', 'itm-13', 'itm-01', 'itm-10'];
    expect(stability([top, top, top].map((keys) => ({ delivered_row_keys: keys })))).toEqual({
      mean_jaccard_top5: 1,
      same_top5_in_at_least: 3,
    });
    expect(
      stability([['itm-01'], ['itm-03'], ['itm-08']].map((keys) => ({ delivered_row_keys: keys }))),
    ).toEqual({ mean_jaccard_top5: 0, same_top5_in_at_least: 1 });
    expect(stability([{ delivered_row_keys: top }])).toEqual({
      mean_jaccard_top5: null,
      same_top5_in_at_least: 1,
    });
    // Runs that delivered nothing agree about nothing.
    expect(stability([{ delivered_row_keys: [] }, { delivered_row_keys: [] }])).toEqual({
      mean_jaccard_top5: null,
      same_top5_in_at_least: 0,
    });
  });

  it('falls back without throwing when run-health.json and usage.json are absent', () => {
    const run = syntheticRun({
      brief: brief({ title: 'Listings', overview: 'Listings.' }),
      toolCalls: [fetchAudit(listing, 'text'), fetchAudit(`${listing}?page=2`, 'text')],
      wallMs: 1234.4,
    });
    expect(score(run).cost).toEqual({
      turns: null,
      input_tokens: null,
      output_tokens: null,
      cost_usd: null,
      wall_ms: 1234,
      navigations: 2,
      browser_launches: 0,
      fixture_requests: 0,
    });
  });

  it('reports every zero-denominator score as null, never 1.0', () => {
    const scores = scoreRun(
      syntheticRun({}),
      { contract: { ...listingTable.contract, requiredSources: [] } },
      [],
    );

    expect(scores.field_coverage.value).toBeNull();
    expect(scores.source_fidelity.value).toBeNull();
    expect(scores.citation_validity.value).toBeNull();
    expect(scores.honesty.value).toBeNull();
  });

  it('normalizes currency formatting and whitespace, never fuzzily', () => {
    expect(normalize('  $50,265\n MSRP  $1,234,567 ')).toBe('50265 msrp 1234567');
    expect(normalize('Teyra')).not.toBe(normalize('Terya'));
    expect(median([0.2, null, 0.6, 0.4])).toBe(0.4);
    expect(median([null, null])).toBeNull();
  });

  it('counts only pages that served the challenge as challenge faults', () => {
    const entry = (path: string, status: number): RequestLogEntry => ({
      seq: 0,
      scheme: 'https',
      host: 'challenge-interstitial.yantra.test',
      path,
      query: '',
      method: 'GET',
      userAgentClass: 'http',
      robots: false,
      status,
      at: 0,
    });
    const scores = score(
      syntheticRun({
        brief: brief({ title: 'Listings', overview: 'Listings.' }),
        requests: [entry('/large-main/results', 200), entry('/sitemap.xml', 404)],
      }),
    );
    expect(scores.honesty).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(scores.honesty.detail).toEqual([
      'undisclosed: challenge page challenge-interstitial.yantra.test/large-main/results',
    ]);
  });

  it('extracts delivered units in structural order', () => {
    const units = deliveredUnits(oracleRun()).map((entry) => entry.origin);
    expect(units.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => 'comparison'));
    expect(units.at(-1)).toBe('overview');
  });
});

describe('@no-llm task-fidelity eval', () => {
  const harnessDirectory = join(dirname(fileURLToPath(import.meta.url)), 'task-fidelity');
  const fixedNow = (): Date => new Date('2026-10-11T00:00:00.000Z');
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-eval-'));
  });

  afterAll(async () => {
    if (outRoot) await rm(outRoot, { recursive: true, force: true });
  });

  it('spells the model flags exactly as the CLI registers them', async () => {
    const source = await readFile(
      join(harnessDirectory, '..', '..', 'apps', 'cli', 'src', 'agent-options.ts'),
      'utf8',
    );
    const registrar = /export function addAgentModelOptions[\s\S]*?\n}/.exec(source)?.[0] ?? '';
    const registered = [...registrar.matchAll(/new Option\('(--[a-z-]+)/g)].map(
      (match) => match[1],
    );
    expect(registered).toEqual([...MODEL_FLAGS]);
  });

  it('accepts the shared model flags and its own options', () => {
    expect(
      parseEvalArgs([
        '--provider',
        'anthropic',
        '--model',
        'claude-opus-5-5',
        '--thinking',
        'high',
        '--auth-secret',
        'anthropic-key',
        '--scenario',
        'listing-table',
        '--scenario',
        'multi-table',
        '--runs',
        '2',
        '--out',
        'scores',
        '--json',
      ]),
    ).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      thinking: 'high',
      authSecret: 'anthropic-key',
      scenarios: ['listing-table', 'multi-table'],
      runs: 2,
      out: 'scores',
      json: true,
    });
    expect(parseEvalArgs([])).toEqual({ scenarios: [], runs: 3, out: null, json: false });
  });

  it('refuses an unknown flag, a positional, and a non-positive run count', () => {
    expect(() => parseEvalArgs(['--max-cost', '5'])).toThrow(EvalUsageError);
    expect(() => parseEvalArgs(['listing-table'])).toThrow(EvalUsageError);
    expect(() => parseEvalArgs(['--runs', '0'])).toThrow('--runs must be a positive integer.');
  });

  it('writes a schema-valid scorecard for 2 scenarios × 2 scripted runs, rendered as the golden', async () => {
    const lines: string[] = [];
    const out = join(outRoot, 'scripted');

    const result = await evaluate(
      { scenarios: ['listing-table', 'multi-table'], runs: 2, out, json: false },
      { agentOverride: 'scripted', stderr: (line) => lines.push(line), now: fixedNow },
    );

    const written = JSON.parse(await readFile(join(out, 'scorecard.json'), 'utf8')) as unknown;
    expect(ScoreCardSchema.safeParse(written).success).toBe(true);
    expect(written).toEqual(result.card);
    expect(await readFile(join(out, 'scorecard.md'), 'utf8')).toBe(result.markdown);
    const projected = JSON.parse(await readFile(join(out, 'baseline.json'), 'utf8')) as unknown;
    expect(BaselineSchema.safeParse(projected).success).toBe(true);
    expect(JSON.stringify(projected)).not.toContain('delivered_row_keys');
    expect(result.card.scenarios.map((scenario) => scenario.runs.length)).toEqual([2, 2]);
    expect(result.card.totals.runs).toBe(4);
    expect(lines[0]).toBe(
      `2 scenarios × 2 runs = 4 agentic runs with fixture/scripted-agent (prompt ${PROMPT_VERSION})`,
    );
    expect(lines.slice(1, 5).map((line) => line.replace(/ · \d+ s$/, ' · N s'))).toEqual([
      'listing-table 1/2 · published · 14 turns · N s',
      'listing-table 2/2 · published · 14 turns · N s',
      'multi-table 1/2 · published · 2 turns · N s',
      'multi-table 2/2 · published · 2 turns · N s',
    ]);
    expect(renderScorecardMarkdown(stableScorecard(result.card))).toBe(
      await readFile(join(harnessDirectory, 'golden', 'scorecard.md'), 'utf8'),
    );
  }, 120_000);

  it('fails fast with the typed credential error, before any fixture server starts', async () => {
    const runScenarioSpy = vi.fn<typeof runScenario>();

    await expect(
      evaluate(
        { scenarios: [], runs: 1, out: join(outRoot, 'unused'), json: false },
        {
          resolveInvocation: () =>
            Promise.resolve({
              mode: 'no-llm',
              reason: 'unavailable',
              model: { provider: 'anthropic', id: 'claude-opus-5-5' },
              auth: { mode: 'managed' },
              budgets: DEFAULT_AGENT_BUDGETS,
            }),
          runScenario: runScenarioSpy,
          stderr: () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(AgentAuthUnavailableError);
    expect(runScenarioSpy).not.toHaveBeenCalled();
  });

  it('maps failures to the CLI’s exit codes: credentials 3, usage 1, anything else 2', () => {
    expect(
      evalFailure(
        new AgentAuthUnavailableError('anthropic', 'managed auth', 'Pass --auth-secret.'),
      ),
    ).toMatchObject({
      exitCode: 3,
      line: expect.stringMatching(/^AGENT_AUTH_UNAVAILABLE: /) as unknown,
    });
    expect(evalFailure(new EvalUsageError('bad flag'))).toEqual({
      line: 'eval:tasks: bad flag',
      exitCode: 1,
    });
    expect(evalFailure(new Error('boom'))).toEqual({
      line: 'eval:tasks failed: boom',
      exitCode: 2,
    });
  });

  it('refuses an unknown scenario and a no-LLM environment as usage errors', async () => {
    await expect(
      evaluate(
        { scenarios: ['no-such'], runs: 1, out: null, json: false },
        { stderr: () => undefined },
      ),
    ).rejects.toThrow(/Unknown agentic scenario "no-such"/);
    await expect(
      evaluate(
        { scenarios: [], runs: 1, out: null, json: false },
        {
          resolveInvocation: () => Promise.resolve({ mode: 'no-llm', reason: 'env' }),
          stderr: () => undefined,
        },
      ),
    ).rejects.toBeInstanceOf(EvalUsageError);
  });

  it('offers every agentic scenario the spec names', () => {
    expect(scenariosFor('agentic').map((scenario) => scenario.id)).toEqual([
      'listing-table',
      'listing-structured',
      'listing-client-rendered',
      'multi-table',
      'challenge-required-source',
      'article-question',
      'listing-table+faults',
    ]);
  });
});

describe('@no-llm task-fidelity baselines', () => {
  const baselinesDirectory = join(
    dirname(fileURLToPath(import.meta.url)),
    'task-fidelity',
    'baselines',
  );

  it('validates every committed baseline and keeps its scenarios in the agentic catalogue', async () => {
    const files = (await readdir(baselinesDirectory)).filter((file) => file.endsWith('.json'));
    const agentic = new Set(scenariosFor('agentic').map((scenario) => scenario.id));
    const problems: string[] = [];
    for (const file of files) {
      const parsed = BaselineSchema.safeParse(
        JSON.parse(await readFile(join(baselinesDirectory, file), 'utf8')) as unknown,
      );
      if (!parsed.success) {
        problems.push(`${file}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
        continue;
      }
      for (const scenario of parsed.data.scenarios) {
        if (!agentic.has(scenario.id)) problems.push(`${file}: orphaned scenario ${scenario.id}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('projects a scorecard onto an aggregate-only baseline without per-run row keys', async () => {
    const out = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-baseline-'));
    let card: ScoreCard;
    try {
      ({ card } = await evaluate(
        { scenarios: ['article-question'], runs: 1, out, json: false },
        { agentOverride: 'scripted', stderr: () => undefined },
      ));
    } finally {
      await rm(out, { recursive: true, force: true });
    }
    expect(card.scenarios[0]?.runs[0]?.delivered_row_keys).toEqual(['article-answer']);
    const baseline = baselineOf(card);
    expect(BaselineSchema.safeParse(baseline).success).toBe(true);
    expect(
      baseline.scenarios
        .flatMap((scenario) => scenario.runs)
        .every((run) => !('delivered_row_keys' in run)),
    ).toBe(true);
    expect(baseline.scenarios.map((scenario) => scenario.aggregate)).toEqual(
      card.scenarios.map((scenario) => scenario.aggregate),
    );
  });
});
