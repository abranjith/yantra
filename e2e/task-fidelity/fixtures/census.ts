/**
 * The fixture census (FEAT-049 TASK-002).
 *
 * The gallery is only evidence while three things stay true: every site encodes
 * one distinct, nameable pattern; nothing outside a page's leading header
 * comment names a real site or repeats the provenance that motivated it; and
 * every truth value sits on the page the truth says it does. Each check returns
 * findings rather than throwing, so a test can prove the census actually fails
 * on a bad gallery instead of only passing on a good one.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

import type { RenderedPage } from './html.js';
import { truthRows } from './inventory.js';
import { FIXTURE_DOMAIN, renderRoute, siteNamed } from './sites.js';
import { structuredPageItems } from './structured-listing.js';

/** The structural view of a site the census inspects (synthetic sites included). */
export interface CensusSite {
  readonly name: string;
  readonly host: string;
  readonly pattern: string;
  readonly provenance: { readonly run?: string; readonly gaps: readonly string[] };
  readonly routes: readonly string[];
  readonly render: (path: string, query: URLSearchParams) => RenderedPage | null;
}

/** One census violation. */
export interface CensusFinding {
  readonly site: string;
  readonly route?: string;
  readonly problem: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The repository's one site-token list, read from `eslint.config.js` so the
 * census and the lint rule can never disagree about what counts as a site name.
 */
export async function loadSiteTokenPattern(): Promise<RegExp> {
  const config = (await import(pathToFileURL(join(repoRoot, 'eslint.config.js')).href)) as {
    readonly SITE_TOKEN_SOURCE?: unknown;
  };
  if (typeof config.SITE_TOKEN_SOURCE !== 'string' || config.SITE_TOKEN_SOURCE.length === 0) {
    throw new Error('eslint.config.js must export SITE_TOKEN_SOURCE as a non-empty string.');
  }
  return new RegExp(config.SITE_TOKEN_SOURCE, 'i');
}

/**
 * Split a rendered body into its leading header comment and the rest.
 *
 * HTML pages lead with `<!-- … -->`; script assets lead with a block comment.
 * A body with no leading comment has an empty header.
 */
export function splitHeader(body: string): { readonly header: string; readonly rest: string } {
  for (const [open, close] of [
    ['<!--', '-->'],
    ['/*', '*/'],
  ] as const) {
    if (body.startsWith(open)) {
      const end = body.indexOf(close);
      if (end >= 0) {
        return { header: body.slice(0, end + close.length), rest: body.slice(end + close.length) };
      }
    }
  }
  return { header: '', rest: body };
}

/** The provenance tokens a site's pages may carry only inside their header comment. */
function provenanceTokens(site: CensusSite): RegExp[] {
  return [
    ...(site.provenance.run === undefined ? [] : [new RegExp(escapeRegExp(site.provenance.run))]),
    ...site.provenance.gaps.map((gap) => new RegExp(`\\b${escapeRegExp(gap)}\\b`)),
  ];
}

/**
 * Census the site gallery: unique names, hosts, and patterns; reserved hosts;
 * provenance present and confined to header comments; no site token outside
 * a header comment; every declared route served.
 *
 * @param sites The gallery (the real registry, or a synthetic one in tests).
 * @param siteTokens The repository's site-token pattern.
 */
export function siteCensus(sites: readonly CensusSite[], siteTokens: RegExp): CensusFinding[] {
  const findings: CensusFinding[] = [];
  for (const key of ['name', 'host', 'pattern'] as const) {
    const seen = new Map<string, string>();
    for (const site of sites) {
      const value = site[key].trim().toLowerCase();
      const first = seen.get(value);
      if (first !== undefined) {
        findings.push({ site: site.name, problem: `duplicate ${key} (also used by ${first})` });
      } else seen.set(value, site.name);
    }
  }
  for (const site of sites) {
    if (site.host !== `${site.name}.${FIXTURE_DOMAIN}`) {
      findings.push({
        site: site.name,
        problem: `host ${site.host} is not <name>.${FIXTURE_DOMAIN}`,
      });
    }
    if (site.pattern.trim().length === 0)
      findings.push({ site: site.name, problem: 'empty pattern' });
    if (site.provenance.gaps.length === 0 && site.provenance.run === undefined) {
      findings.push({ site: site.name, problem: 'no provenance entry' });
    }
    if (site.routes.length === 0) findings.push({ site: site.name, problem: 'declares no routes' });
    const tokens = provenanceTokens(site);
    for (const route of site.routes) {
      const url = new URL(route, `http://${site.host}`);
      const page = site.render(url.pathname, url.searchParams);
      if (page === null) {
        findings.push({ site: site.name, route, problem: 'declared route is not served' });
        continue;
      }
      const { header, rest } = splitHeader(page.body);
      if (header.length === 0) {
        findings.push({ site: site.name, route, problem: 'page has no leading header comment' });
      }
      for (const token of tokens) {
        if (!token.test(header)) {
          findings.push({
            site: site.name,
            route,
            problem: `header comment omits provenance ${token.source}`,
          });
        }
        if (token.test(rest)) {
          findings.push({
            site: site.name,
            route,
            problem: `provenance ${token.source} appears outside the header comment`,
          });
        }
      }
      const token = siteTokens.exec(rest);
      if (token !== null) {
        findings.push({
          site: site.name,
          route,
          problem: `site token "${token[0]}" outside the header comment`,
        });
      }
    }
  }
  return findings;
}

/**
 * Every string literal and template chunk in the given TypeScript sources that
 * matches the site-token pattern — the same AST nodes the ESLint rule selects,
 * so a site name in a comment stays legal and a site name in a value does not.
 *
 * @param files Source files as `{ path, text }`.
 * @param siteTokens The repository's site-token pattern.
 */
export function sourceLiteralFindings(
  files: readonly { readonly path: string; readonly text: string }[],
  siteTokens: RegExp,
): CensusFinding[] {
  const findings: CensusFinding[] = [];
  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        const token = siteTokens.exec(node.text);
        if (token !== null) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          findings.push({
            site: file.path,
            problem: `site token "${token[0]}" in a literal at line ${line + 1}`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return findings;
}

/** Read the fixture TypeScript sources the literal scan covers. */
export async function fixtureSources(
  paths: readonly string[],
): Promise<{ readonly path: string; readonly text: string }[]> {
  return Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}

/**
 * Every truth field placed where the truth says it renders: title, price, MSRP,
 * seller, and distance on the item's `faceted-listing` results page; colors,
 * drivetrain, and condition on its detail page; and name, price, seller, and
 * color in the `structured-listing` JSON-LD.
 */
export function truthPlacementFindings(): CensusFinding[] {
  const findings: CensusFinding[] = [];
  const faceted = siteNamed('faceted-listing');
  const structured = siteNamed('structured-listing');
  const body = (site: typeof faceted, route: string): string =>
    renderRoute(site, route)?.body ?? '';

  for (const row of truthRows()) {
    const listingUrl = new URL(row.listingUrl);
    const listing = body(faceted, `${listingUrl.pathname}${listingUrl.search}`);
    const detail = body(faceted, new URL(row.detailUrl).pathname);
    const expectations: readonly [string, string, string][] = [
      ['listing', listing, `>${row.fields.title}</a>`],
      ['listing', listing, `>${row.fields.price}</span>`],
      ['listing', listing, `MSRP $${row.fields.msrp}`],
      ['listing', listing, `>${row.fields.seller}</a>`],
      ['listing', listing, `${row.fields.distance} away`],
      ['detail', detail, `<dd>${row.fields.exteriorColor}</dd>`],
      ['detail', detail, `<dd>${row.fields.interiorColor}</dd>`],
      ['detail', detail, `<dd>${row.fields.drivetrain}</dd>`],
      ['detail', detail, `$${row.fields.price}`],
    ];
    for (const [where, page, text] of expectations) {
      if (!page.includes(text)) {
        findings.push({
          site: 'faceted-listing',
          route: row.itemId,
          problem: `${where} page lacks ${text}`,
        });
      }
    }
  }

  const rows = new Map(truthRows().map((row) => [row.itemId, row]));
  const page1 = body(structured, '/results');
  for (const entry of structuredPageItems(1)) {
    const row = rows.get(entry.id);
    if (row === undefined) continue;
    for (const text of [
      `"name": "${row.fields.title}"`,
      `"price": ${entry.price}`,
      `"name": "${row.fields.seller}"`,
      `"color": "${row.fields.exteriorColor}"`,
      `"value": "${row.fields.interiorColor}"`,
    ]) {
      if (!page1.includes(text)) {
        findings.push({
          site: 'structured-listing',
          route: entry.id,
          problem: `JSON-LD lacks ${text}`,
        });
      }
    }
  }
  return findings;
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
