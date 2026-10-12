/**
 * Link harvest, classification, ranking, and bounds (FEAT-051).
 *
 * A page read that returns no links makes pagination, facet filters, and detail
 * pages unreachable by construction: run `20260925T130634Z` spent 14 of its 15
 * turns trying to reach them (G3). Every read therefore reports the links a
 * page offers, each with a {@link LinkKind} saying why it is offered.
 *
 * Classification is structural — `rel` tokens, sibling-group shape, landmark
 * membership, and a short documented vocabulary of pagination words — never a
 * host, class, or id.
 */

import { domainFromUrl } from '../../ranking/recording.js';
import { canonicalUrl } from '../url-identity.js';

import { attrOf, tagOf, type PageIndex, type PageNode, elementChildren } from './dom.js';
import type { LinkKind, PageLink } from './types.js';

/** Links shown per page: enough for pagination, facets, and a page of content links. */
export const MAX_LINKS = 40;

/** Characters kept of a link's text: a label, not a paragraph. */
export const LINK_TEXT_MAX = 80;

/**
 * Accessible names that mark a pagination control. Generic interface
 * vocabulary (English words plus the arrow glyphs pagination widgets render),
 * in the same category as ARIA roles — not a site list. Localization is a
 * tracked enhancement (TODO).
 */
export const PAGINATION_WORDS: ReadonlySet<string> = new Set([
  'next',
  'previous',
  'prev',
  'older',
  'newer',
  '»',
  '›',
  '«',
  '‹',
]);

/** Filler words a pagination name may carry alongside a {@link PAGINATION_WORDS} entry ("Next page"). */
const PAGINATION_FILLER: ReadonlySet<string> = new Set(['page']);

/** Ranking order of offered kinds (`record` links are never offered in `links[]`). */
const KIND_RANK: Readonly<Record<LinkKind, number>> = {
  pagination: 0,
  facet: 1,
  content: 2,
  navigation: 3,
  record: 4,
};

/** When one URL appears with several kinds, the strongest claim wins. */
const KIND_PRECEDENCE: Readonly<Record<LinkKind, number>> = {
  record: 0,
  pagination: 1,
  facet: 2,
  content: 3,
  navigation: 4,
};

/** One followable anchor (or `<link rel=next|prev>`), before dedup. */
export interface LinkCandidate {
  readonly node: PageNode;
  /** Absolute http(s) URL. */
  readonly url: string;
  readonly canonical: string;
  /** Accessible text, bounded; may be empty. */
  readonly text: string;
  /** Lowercased `rel` tokens. */
  readonly rel: readonly string[];
  /** Document order. */
  readonly order: number;
}

/** The finished link view of a page. */
export interface LinkSummary {
  /** Offered links, ranked and bounded; record links excluded. */
  readonly links: readonly PageLink[];
  /** Distinct links found (every kind). */
  readonly found: number;
  /** Distinct links found per kind; sums to {@link found}. */
  readonly byKind: Partial<Record<LinkKind, number>>;
  /** Distinct record primary links (excluded from {@link links}). */
  readonly recordLinkCount: number;
}

/**
 * Whether `candidate` is a variant of the `page` URL: same origin, and either
 * the same path with a different query, the page path extended by exactly one
 * segment, or the same path except its last segment. Facets and pagination
 * link to variants; a link to an unrelated page is not one.
 *
 * @param page The page's URL.
 * @param candidate The link's absolute URL.
 */
export function isUrlVariant(page: string, candidate: string): boolean {
  const left = parseHttpUrl(page);
  const right = parseHttpUrl(candidate);
  if (left === null || left.origin !== right?.origin) return false;
  const leftPath = pathSegments(left.pathname);
  const rightPath = pathSegments(right.pathname);
  const prefixMatches = (length: number): boolean =>
    leftPath.slice(0, length).every((segment, index) => segment === rightPath[index]);
  if (leftPath.length === rightPath.length && prefixMatches(leftPath.length)) {
    return left.search !== right.search;
  }
  if (rightPath.length === leftPath.length + 1 && prefixMatches(leftPath.length)) return true;
  return (
    leftPath.length > 0 &&
    rightPath.length === leftPath.length &&
    prefixMatches(leftPath.length - 1)
  );
}

/**
 * Collects every followable link: `a[href]` outside hidden subtrees plus
 * `link[rel~=next|prev]`, resolved against `<base href>` (else the page URL).
 * Only http(s) survives; `javascript:`, `data:`, `mailto:`, `tel:`, fragment-
 * only, and same-document links are dropped.
 *
 * @param index The page index.
 * @param pageUrl The page's final URL.
 * @returns The candidates, plus the anchors dropped as same-document (a
 *   selected facet value links to the page itself).
 */
export function harvestLinks(
  index: PageIndex,
  pageUrl: string,
): { readonly candidates: LinkCandidate[]; readonly selfLinks: Set<PageNode> } {
  const base = baseUrl(index, pageUrl);
  const pageKey = canonicalUrl(pageUrl);
  const out: LinkCandidate[] = [];
  const selfLinks = new Set<PageNode>();
  for (const node of index.elements) {
    const tag = tagOf(node);
    const href = attrOf(node, 'href');
    if (href === undefined) continue;
    const rel = (attrOf(node, 'rel') ?? '').toLowerCase().split(/\s+/u).filter(Boolean);
    if (tag === 'link') {
      if (!rel.includes('next') && !rel.includes('prev')) continue;
    } else if (tag !== 'a' || index.factsOf(node).hidden) {
      continue;
    }
    if (href.trim().startsWith('#')) continue;
    const url = resolveHttp(href, base);
    if (url === null) continue;
    const canonical = canonicalUrl(url);
    if (canonical === pageKey) {
      selfLinks.add(node);
      continue;
    }
    out.push({
      node,
      url,
      canonical,
      text:
        tag === 'link' ? (rel.includes('next') ? 'next' : 'previous') : accessibleName(index, node),
      rel,
      order: index.factsOf(node).order,
    });
  }
  return { candidates: out, selfLinks };
}

/**
 * The structural kinds TASK-001 assigns: `pagination` (rel, numbered sibling
 * group, or a pagination word linking to a page variant), `navigation`
 * (inside a landmark), else `content`. Record and facet kinds are assigned by
 * the record module and passed to {@link summarizeLinks} as overrides.
 *
 * @param index The page index.
 * @param pageUrl The page's final URL.
 * @param candidates The harvested links.
 */
export function classifyLinks(
  index: PageIndex,
  pageUrl: string,
  candidates: readonly LinkCandidate[],
): Map<PageNode, LinkKind> {
  const kinds = new Map<PageNode, LinkKind>();
  const numbered = numberedPaginationNodes(candidates);
  for (const candidate of candidates) {
    const isPagination =
      candidate.rel.includes('next') ||
      candidate.rel.includes('prev') ||
      numbered.has(candidate.node) ||
      (isPaginationName(candidate.text) && isUrlVariant(pageUrl, candidate.url));
    kinds.set(
      candidate.node,
      isPagination
        ? 'pagination'
        : index.factsOf(candidate.node).landmark
          ? 'navigation'
          : 'content',
    );
  }
  return kinds;
}

/**
 * Dedupes by canonical URL (first non-empty text wins; the strongest kind
 * wins), ranks by kind then same-site then document order, and bounds at
 * {@link MAX_LINKS}. Record links are counted, never offered.
 *
 * @param pageUrl The page's final URL.
 * @param candidates The harvested links.
 * @param kinds Each candidate's kind (structural kinds with record/facet overrides applied).
 */
export function summarizeLinks(
  pageUrl: string,
  candidates: readonly LinkCandidate[],
  kinds: ReadonlyMap<PageNode, LinkKind>,
): LinkSummary {
  const pageHost = domainFromUrl(pageUrl);
  interface Merged {
    url: string;
    text: string;
    kind: LinkKind;
    order: number;
  }
  const merged = new Map<string, Merged>();
  for (const candidate of candidates) {
    const kind = kinds.get(candidate.node) ?? 'content';
    const existing = merged.get(candidate.canonical);
    if (existing === undefined) {
      merged.set(candidate.canonical, {
        url: candidate.url,
        text: candidate.text,
        kind,
        order: candidate.order,
      });
      continue;
    }
    if (KIND_PRECEDENCE[kind] < KIND_PRECEDENCE[existing.kind]) {
      // The stronger claim names the link: a facet's own label, not the
      // header shortcut that happens to share its URL.
      existing.kind = kind;
      if (candidate.text.length > 0) existing.text = candidate.text;
    } else if (existing.text.length === 0 && candidate.text.length > 0) {
      existing.text = candidate.text;
    }
  }
  const byKind: Partial<Record<LinkKind, number>> = {};
  const offered: PageLink[] = [];
  let recordLinkCount = 0;
  const orders = new Map<PageLink, number>();
  for (const entry of merged.values()) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    if (entry.kind === 'record') {
      recordLinkCount += 1;
      continue;
    }
    const link: PageLink = {
      text: entry.text,
      url: entry.url,
      kind: entry.kind,
      sameSite: pageHost !== null && domainFromUrl(entry.url) === pageHost,
    };
    orders.set(link, entry.order);
    offered.push(link);
  }
  offered.sort(
    (left, right) =>
      KIND_RANK[left.kind] - KIND_RANK[right.kind] ||
      Number(right.sameSite) - Number(left.sameSite) ||
      (orders.get(left) ?? 0) - (orders.get(right) ?? 0),
  );
  return { links: offered.slice(0, MAX_LINKS), found: merged.size, byKind, recordLinkCount };
}

/** A link's accessible text: its visible text, else aria-label, title, then an image's alt. */
export function accessibleName(index: PageIndex, node: PageNode): string {
  const candidates = [
    index.textOf(node),
    attrOf(node, 'aria-label') ?? '',
    attrOf(node, 'title') ?? '',
    ...index.within(node, (child) => tagOf(child) === 'img').map((img) => attrOf(img, 'alt') ?? ''),
  ];
  for (const candidate of candidates) {
    const text = candidate.replace(/\s+/gu, ' ').trim();
    if (text.length > 0) return text.length > LINK_TEXT_MAX ? text.slice(0, LINK_TEXT_MAX) : text;
  }
  return '';
}

/** Whether an accessible name is a pagination control's ("Next", "Next page", "»"). */
function isPaginationName(text: string): boolean {
  const tokens = text.toLowerCase().split(/\s+/u).filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.some((token) => PAGINATION_WORDS.has(token)) &&
    tokens.every((token) => PAGINATION_WORDS.has(token) || PAGINATION_FILLER.has(token))
  );
}

/**
 * Anchors in a numbered page list: a sibling group of at least two anchors
 * whose texts are positive integers and whose URLs differ from each other in
 * exactly one query value or one numeric path segment. A wrapper holding only
 * the anchor (`<li><a>2</a></li>`) is looked through to its own parent.
 */
function numberedPaginationNodes(candidates: readonly LinkCandidate[]): Set<PageNode> {
  const groups = new Map<PageNode, LinkCandidate[]>();
  for (const candidate of candidates) {
    if (!/^[1-9]\d{0,3}$/u.test(candidate.text)) continue;
    const parent = candidate.node.parent ?? null;
    if (parent === null) continue;
    const key = elementChildren(parent).length === 1 && parent.parent ? parent.parent : parent;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const out = new Set<PageNode>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group;
    if (first === undefined) continue;
    if (rest.every((other) => differsInOneSlot(first.url, other.url))) {
      for (const member of group) out.add(member.node);
    }
  }
  return out;
}

/** Whether two URLs differ in exactly one query value (a key present in one counts) or one numeric path segment. */
function differsInOneSlot(left: string, right: string): boolean {
  const a = parseHttpUrl(left);
  const b = parseHttpUrl(right);
  if (a === null || a.origin !== b?.origin) return false;
  const pathA = pathSegments(a.pathname);
  const pathB = pathSegments(b.pathname);
  if (pathA.join('/') === pathB.join('/')) {
    const keys = new Set([...a.searchParams.keys(), ...b.searchParams.keys()]);
    let differences = 0;
    for (const key of keys) {
      if (
        JSON.stringify(a.searchParams.getAll(key)) !== JSON.stringify(b.searchParams.getAll(key))
      ) {
        differences += 1;
      }
    }
    return differences === 1;
  }
  if (pathA.length !== pathB.length || a.search !== b.search) return false;
  const differing = pathA.filter((segment, index) => segment !== pathB[index]);
  const index = pathA.findIndex((segment, position) => segment !== pathB[position]);
  return (
    differing.length === 1 && /^\d+$/u.test(pathA[index] ?? '') && /^\d+$/u.test(pathB[index] ?? '')
  );
}

/** The document's `<base href>` resolved against the page URL, else the page URL. */
function baseUrl(index: PageIndex, pageUrl: string): string {
  const base = index.elements.find((node) => tagOf(node) === 'base' && attrOf(node, 'href'));
  const href = base === undefined ? undefined : attrOf(base, 'href');
  if (href === undefined) return pageUrl;
  return resolveHttp(href, pageUrl) ?? pageUrl;
}

/** Resolves an href to an absolute http(s) URL, or null for any other scheme or a parse failure. */
function resolveHttp(href: string, base: string): string | null {
  const parsed = parseHttpUrl(href.trim(), base);
  return parsed === null ? null : parsed.href;
}

/** Parses an http(s) URL; null for other schemes or unparseable input (a malformed href grants nothing). */
function parseHttpUrl(value: string, base?: string): URL | null {
  if (!URL.canParse(value, base)) return null;
  const url = new URL(value, base);
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}
