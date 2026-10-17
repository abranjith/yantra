/**
 * The task-fidelity site registry (FEAT-049).
 *
 * Each site encodes one nameable, generic web pattern and is served under its
 * own reserved hostname, `<name>.yantra.test` (RFC 2606 reserves `.test`, so the
 * name can never resolve publicly). Distinct hostnames matter: host budgets,
 * required-source checks, and ranking all key off the hostname, and fixtures
 * sharing one loopback address would make source fidelity trivially true.
 *
 * Renderers are pure and deterministic: the same path and query always produce
 * byte-identical output, read from `inventory.ts` or a checked-in corpus.
 */

import { ARTICLE_PATTERN, ARTICLE_PROVENANCE, ARTICLE_ROUTES, renderArticle } from './article.js';
import {
  CHALLENGE_INTERSTITIAL_PATTERN,
  CHALLENGE_INTERSTITIAL_PROVENANCE,
  CHALLENGE_INTERSTITIAL_ROUTES,
  renderChallengeInterstitial,
} from './challenge-interstitial.js';
import {
  CLIENT_RENDERED_LISTING_PATTERN,
  CLIENT_RENDERED_LISTING_PROVENANCE,
  CLIENT_RENDERED_LISTING_ROUTES,
  renderClientRenderedListing,
} from './client-rendered-listing.js';
import {
  FACETED_LISTING_PATTERN,
  FACETED_LISTING_PROVENANCE,
  FACETED_LISTING_ROUTES,
  renderFacetedListing,
} from './faceted-listing.js';
import type { RenderedPage } from './html.js';
import {
  MULTI_TABLE_PATTERN,
  MULTI_TABLE_PROVENANCE,
  MULTI_TABLE_ROUTES,
  renderMultiTable,
} from './multi-table.js';
import {
  STRUCTURED_LISTING_PATTERN,
  STRUCTURED_LISTING_PROVENANCE,
  STRUCTURED_LISTING_ROUTES,
  renderStructuredListing,
} from './structured-listing.js';
import {
  TEST_FORM_PATTERN,
  TEST_FORM_PROVENANCE,
  TEST_FORM_ROUTES,
  renderTestForm,
} from './test-form.js';

/** The reserved second-level domain every fixture host lives under. */
export const FIXTURE_DOMAIN = 'yantra.test';

/** A plan gap identifier, cited as provenance only. */
export type GapId = 'G2' | 'G3' | 'G4' | 'G5' | 'G10';

/** One fixture site. */
export interface TaskSite {
  /** The pattern name; doubles as the hostname label. */
  readonly name: SiteName;
  /** `<name>.yantra.test`. */
  readonly host: string;
  /** The one-sentence generic pattern the site encodes. Unique. */
  readonly pattern: string;
  /** Evidence for why the pattern exists. Rendered only into the header comment. */
  readonly provenance: { readonly run?: string; readonly gaps: readonly GapId[] };
  /** Every route the site serves, as `path?query`; the census renders each one. */
  readonly routes: readonly string[];
  /** Render one route, or null for an unknown path. Pure and deterministic. */
  readonly render: (path: string, query: URLSearchParams) => RenderedPage | null;
}

export const SITE_NAMES = [
  'faceted-listing',
  'structured-listing',
  'client-rendered-listing',
  'challenge-interstitial',
  'article',
  'multi-table',
  'test-form',
] as const;

export type SiteName = (typeof SITE_NAMES)[number];

export const TASK_SITES: readonly TaskSite[] = Object.freeze([
  site(
    'faceted-listing',
    FACETED_LISTING_PATTERN,
    FACETED_LISTING_PROVENANCE,
    FACETED_LISTING_ROUTES,
    renderFacetedListing,
  ),
  site(
    'structured-listing',
    STRUCTURED_LISTING_PATTERN,
    STRUCTURED_LISTING_PROVENANCE,
    STRUCTURED_LISTING_ROUTES,
    renderStructuredListing,
  ),
  site(
    'client-rendered-listing',
    CLIENT_RENDERED_LISTING_PATTERN,
    CLIENT_RENDERED_LISTING_PROVENANCE,
    CLIENT_RENDERED_LISTING_ROUTES,
    renderClientRenderedListing,
  ),
  site(
    'challenge-interstitial',
    CHALLENGE_INTERSTITIAL_PATTERN,
    CHALLENGE_INTERSTITIAL_PROVENANCE,
    CHALLENGE_INTERSTITIAL_ROUTES,
    renderChallengeInterstitial,
  ),
  site('article', ARTICLE_PATTERN, ARTICLE_PROVENANCE, ARTICLE_ROUTES, renderArticle),
  site(
    'multi-table',
    MULTI_TABLE_PATTERN,
    MULTI_TABLE_PROVENANCE,
    MULTI_TABLE_ROUTES,
    renderMultiTable,
  ),
  site('test-form', TEST_FORM_PATTERN, TEST_FORM_PROVENANCE, TEST_FORM_ROUTES, renderTestForm),
]);

/** The site served at `host`, or undefined when no fixture owns it. */
export function siteForHost(host: string): TaskSite | undefined {
  const hostname = host.toLowerCase().replace(/:\d+$/, '');
  return TASK_SITES.find((candidate) => candidate.host === hostname);
}

/** The site registered under `name`; throws for an unregistered name. */
export function siteNamed(name: SiteName): TaskSite {
  const found = TASK_SITES.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no task-fidelity site named ${name}`);
  return found;
}

/** Render a `path?query` route of `site`. */
export function renderRoute(target: TaskSite, route: string): RenderedPage | null {
  const url = new URL(route, originOf(target.name));
  return target.render(url.pathname, url.searchParams);
}

/** The origin a site is reached at (`http://faceted-listing.yantra.test`). */
export function originOf(name: SiteName): string {
  return `http://${name}.${FIXTURE_DOMAIN}`;
}

function site(
  name: SiteName,
  pattern: string,
  provenance: TaskSite['provenance'],
  routes: readonly string[],
  render: TaskSite['render'],
): TaskSite {
  return { name, host: `${name}.${FIXTURE_DOMAIN}`, pattern, provenance, routes, render };
}
