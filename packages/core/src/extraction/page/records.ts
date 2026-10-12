/**
 * Repeated records and facet lists (FEAT-051, plan §7 "Collection extraction").
 *
 * A results page keeps its data in repeated cards, which is exactly what an
 * article extractor discards: run `20260925T130634Z` got facet labels and bare
 * price blocks back, with every card's title and seller dropped (G2). This
 * module finds the cards structurally and reads each one whole:
 *
 * 1. **Candidates.** A container whose element children share a structural
 *    signature (tag plus descendant-tag multiset to depth 3; class and id are
 *    never read), each holding a link and non-trivial text.
 * 2. **Score.** Count × text richness × link and numeric-token presence,
 *    penalized inside page-chrome landmarks. A list of short labels with
 *    counts linking to variants of the page URL is a **facet list**: its
 *    links become `facet` links and it never yields records.
 * 3. **Per record.** Title, primary link, ordered text segments (anchor text
 *    counts — the seller in a linked seller line stays), label/value fields,
 *    typed numbers, and secondary links, bounded per record.
 *
 * No step consults a host, URL literal, class, or id.
 */

import { createHash } from 'node:crypto';

import { canonicalUrl } from '../url-identity.js';

import {
  cleanRun,
  contains,
  elementChildren,
  tagOf,
  type PageIndex,
  type PageNode,
} from './dom.js';
import { cellPair, definitionPairs, parseLabelValue, type SourcedField } from './fields.js';
import { isUrlVariant, type LinkCandidate } from './links.js';
import type { LinkKind, NumericToken, PageField, PageRecord, RecordLink } from './types.js';

/** Records shown per page. */
export const MAX_RECORDS = 25;

/** Text per record (title, segments, field values): a card, not a page. */
export const RECORD_TEXT_CHARS = 400;

/** Siblings needed before a repeated structure is a collection. */
export const MIN_RECORDS = 3;

/** Jaccard similarity a sibling's signature needs to the modal signature. */
export const SIBLING_SIMILARITY = 0.6;

/** Visible characters a record must hold (an icon row is not a record). */
export const RECORD_MIN_TEXT = 20;

/** Score multiplier for candidates inside page-chrome landmarks (menus repeat too). */
export const LANDMARK_PENALTY = 0.2;

/** Characters in a facet label: a filter value, not a description. */
export const FACET_LABEL_MAX = 60;

/**
 * Items a facet group needs. Lower than {@link MIN_RECORDS} because a
 * refinement group may offer only two values (new/used, AWD/FWD), and each
 * item is already individually recognizable by three conjunctive tests (short
 * label, count token, link to a variant of the page).
 */
export const FACET_MIN_ITEMS = 2;

/** Share of a group's items that must pass the facet tests. */
const FACET_SHARE = 0.6;

/** Descendant depth a structural signature covers. */
const SIGNATURE_DEPTH = 3;

/** Children compared pairwise when no signature repeats (bounds the medoid search). */
const MEDOID_SAMPLE = 50;

const RECORD_FIELDS_MAX = 8;
const RECORD_NUMBERS_MAX = 6;
const RECORD_LINKS_MAX = 3;

const HEADING_TAGS: ReadonlySet<string> = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/**
 * ISO 4217 codes recognized next to an amount. A vocabulary subset (the most
 * traded currencies), not a site list; an unlisted three-letter word such as a
 * trim or drivetrain code next to a number is not a currency.
 */
const CURRENCY_CODES: ReadonlySet<string> = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'HUF', 'MXN', 'BRL', 'ZAR', 'SGD', 'HKD', 'KRW', 'TWD', 'THB', 'IDR', 'MYR',
  'PHP', 'AED', 'SAR', 'TRY', 'ILS',
]); // prettier-ignore

/** A record-bearing container and the records it yields. */
interface Candidate {
  readonly container: PageNode;
  readonly items: readonly PageNode[];
  readonly score: number;
}

/** What the record scan found. */
export interface RecordScan {
  /** Up to {@link MAX_RECORDS} records from the winning region. */
  readonly records: readonly PageRecord[];
  /** Records in the winning region. */
  readonly found: number;
  /** Shown records whose text was cut to {@link RECORD_TEXT_CHARS}. */
  readonly truncated: number;
  /** Other qualifying regions that lost. */
  readonly otherRegions: number;
  /** Link kinds this scan assigns: `record` primary links and `facet` links. */
  readonly kinds: ReadonlyMap<PageNode, LinkKind>;
  /** Visible characters in the shown records (title, segments, field values). */
  readonly chars: number;
}

/**
 * Finds facet lists and the winning record region.
 *
 * @param index The page index.
 * @param pageUrl The page's final URL.
 * @param links Harvested link candidates, keyed by anchor.
 * @param selfLinks Anchors that point at the page itself (a selected facet value).
 */
export function scanRecords(
  index: PageIndex,
  pageUrl: string,
  links: ReadonlyMap<PageNode, LinkCandidate>,
  selfLinks: ReadonlySet<PageNode>,
): RecordScan {
  const kinds = new Map<PageNode, LinkKind>();
  const facetContainers = findFacetLists(index, pageUrl, links, selfLinks);
  for (const container of facetContainers) {
    for (const anchor of index.within(container, (node) => links.has(node))) {
      kinds.set(anchor, 'facet');
    }
  }

  const candidates = findCandidates(index, facetContainers);
  const winner = chooseWinner(candidates);
  if (winner === null) {
    return { records: [], found: 0, truncated: 0, otherRegions: 0, kinds, chars: 0 };
  }

  const anchorsOf = (item: PageNode): PageNode[] => index.within(item, (node) => links.has(node));
  const primaries = winner.items.map((item) => primaryAnchor(index, item, anchorsOf(item)));
  for (const primary of primaries) if (primary !== null) kinds.set(primary, 'record');

  const keys = new Map<string, number>();
  let truncated = 0;
  let chars = 0;
  const records = winner.items.slice(0, MAX_RECORDS).map((item, position) => {
    const read = readRecord(index, item, primaries[position] ?? null, anchorsOf(item), links);
    if (read.truncated) truncated += 1;
    chars += read.chars;
    const seen = keys.get(read.record.key) ?? 0;
    keys.set(read.record.key, seen + 1);
    return seen === 0 ? read.record : { ...read.record, key: `${read.record.key}#${seen + 1}` };
  });

  return {
    records,
    found: winner.items.length,
    truncated,
    otherRegions: candidates.length - 1,
    kinds,
    chars,
  };
}

/**
 * Typed numbers in text, in order of appearance: currency (a symbol or ISO
 * code adjacent to an amount), distance (an amount followed by a distance
 * unit), and count (a parenthesized integer).
 *
 * @param text The text to scan.
 * @param limit The most tokens to return.
 */
export function numericTokens(text: string, limit = RECORD_NUMBERS_MAX): NumericToken[] {
  const amount = String.raw`\d[\d,]*(?:\.\d+)?`;
  const patterns: readonly { kind: NumericToken['kind']; regex: RegExp }[] = [
    {
      kind: 'currency',
      regex: new RegExp(String.raw`[$€£¥₹]\s?${amount}|${amount}\s?[$€£¥₹]`, 'gu'),
    },
    {
      kind: 'currency',
      regex: new RegExp(String.raw`\b[A-Z]{3}\s?${amount}|${amount}\s?[A-Z]{3}\b`, 'gu'),
    },
    {
      kind: 'distance',
      regex: new RegExp(String.raw`${amount}\s?(?:miles|mi|kilometers|km)\b`, 'gu'),
    },
    { kind: 'count', regex: /\(\d[\d,]*\)/gu },
  ];
  const found: { start: number; end: number; token: NumericToken }[] = [];
  for (const { kind, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      const span = match[0];
      const start = match.index;
      if (kind === 'currency' && /[A-Z]{3}/u.test(span) && !/[$€£¥₹]/u.test(span)) {
        const code = /[A-Z]{3}/u.exec(span)?.[0] ?? '';
        if (!CURRENCY_CODES.has(code)) continue;
      }
      const digits = /\d[\d,]*(?:\.\d+)?/u.exec(span)?.[0] ?? '';
      const value = Number.parseFloat(digits.replaceAll(',', ''));
      if (!Number.isFinite(value)) continue;
      const end = start + span.length;
      if (found.some((other) => start < other.end && other.start < end)) continue;
      found.push({ start, end, token: { kind, text: span.trim(), value } });
    }
  }
  return found
    .sort((left, right) => left.start - right.start)
    .slice(0, limit)
    .map((entry) => entry.token);
}

/** Groups whose items are short labels with counts linking to variants of the page. */
function findFacetLists(
  index: PageIndex,
  pageUrl: string,
  links: ReadonlyMap<PageNode, LinkCandidate>,
  selfLinks: ReadonlySet<PageNode>,
): PageNode[] {
  const out: PageNode[] = [];
  for (const node of index.elements) {
    const facts = index.factsOf(node);
    if (facts.hidden || facts.linkCount < 1) continue;
    const items = elementChildren(node);
    if (items.length < FACET_MIN_ITEMS) continue;
    const passing = items.filter((item) => isFacetItem(index, item, pageUrl, links, selfLinks));
    if (passing.length / items.length >= FACET_SHARE && passing.length >= FACET_MIN_ITEMS) {
      if (!out.some((existing) => contains(existing, node))) out.push(node);
    }
  }
  return out;
}

function isFacetItem(
  index: PageIndex,
  item: PageNode,
  pageUrl: string,
  links: ReadonlyMap<PageNode, LinkCandidate>,
  selfLinks: ReadonlySet<PageNode>,
): boolean {
  const text = index.textOf(item);
  if (text.length === 0 || text.length > FACET_LABEL_MAX) return false;
  const anchor =
    (tagOf(item) === 'a' ? item : undefined) ??
    index.within(item, (node) => tagOf(node) === 'a')[0];
  if (anchor === undefined) return false;
  const target = links.get(anchor);
  const linksToVariant =
    selfLinks.has(anchor) || (target !== undefined && isUrlVariant(pageUrl, target.url));
  return linksToVariant && hasCountToken(index, item, text);
}

/**
 * A label plus a count: a parenthesized integer, or a trailing integer in an
 * element of its own. The label must hold a letter, so a numbered page list
 * (`<li><a>2</a></li>`) is never mistaken for a facet group.
 */
function hasCountToken(index: PageIndex, item: PageNode, text: string): boolean {
  const parenthesized = /\(\d[\d,]*\)/u;
  if (parenthesized.test(text)) return /\p{L}/u.test(text.replace(parenthesized, ''));
  const elements = index.within(item, () => true);
  const last = elements[elements.length - 1];
  if (last === undefined) return false;
  const count = index.textOf(last);
  return /^\d[\d,]*$/u.test(count) && /\p{L}/u.test(text.slice(0, text.length - count.length));
}

/** Every container whose similar children qualify as records. */
function findCandidates(index: PageIndex, facetContainers: readonly PageNode[]): Candidate[] {
  const out: Candidate[] = [];
  const signatures = new Map<PageNode, Map<string, number>>();
  const signatureOf = (node: PageNode): Map<string, number> => {
    let signature = signatures.get(node);
    if (signature === undefined) {
      signature = structuralSignature(node);
      signatures.set(node, signature);
    }
    return signature;
  };
  for (const node of index.elements) {
    const facts = index.factsOf(node);
    if (facts.hidden || facts.linkCount < MIN_RECORDS) continue;
    if (facetContainers.some((facet) => facet === node || contains(facet, node))) continue;
    const children = elementChildren(node).filter((child) => tagOf(child) !== 'tr');
    if (children.length < MIN_RECORDS) continue;
    const modal = modalSignature(children, signatureOf);
    const items = children.filter((child) => {
      const childFacts = index.factsOf(child);
      return (
        !childFacts.hidden &&
        childFacts.linkCount >= 1 &&
        childFacts.textLength >= RECORD_MIN_TEXT &&
        jaccard(signatureOf(child), modal) >= SIBLING_SIMILARITY
      );
    });
    if (items.length < MIN_RECORDS) continue;
    const meanText =
      items.reduce((sum, item) => sum + index.factsOf(item).textLength, 0) / items.length;
    const numericShare =
      items.filter((item) => numericTokens(index.textOf(item), 1).length > 0).length / items.length;
    const linkShare = items.length / children.length;
    const score =
      items.length *
      Math.log(1 + meanText) *
      (1 + linkShare) *
      (1 + numericShare) *
      (facts.landmark ? LANDMARK_PENALTY : 1);
    out.push({ container: node, items, score });
  }
  return out;
}

/**
 * The highest-scoring candidate, except that when it sits inside a record of
 * another candidate whose records each contain a qualifying region, that
 * outer candidate wins: cards, not card fragments, become records.
 */
function chooseWinner(candidates: readonly Candidate[]): Candidate | null {
  const ranked = [...candidates].sort((left, right) => right.score - left.score);
  let winner = ranked[0] ?? null;
  for (let guard = 0; winner !== null && guard < candidates.length; guard += 1) {
    const current: Candidate = winner;
    const outer = candidates.find(
      (other) =>
        other !== current &&
        other.items.some(
          (item) => item === current.container || contains(item, current.container),
        ) &&
        other.items.every((item) =>
          candidates.some(
            (inner) =>
              inner !== other && (inner.container === item || contains(item, inner.container)),
          ),
        ),
    );
    if (outer === undefined) break;
    winner = outer;
  }
  return winner;
}

/** Tag name plus the multiset of descendant tag names to {@link SIGNATURE_DEPTH}. */
function structuralSignature(node: PageNode): Map<string, number> {
  const signature = new Map<string, number>([[`^${tagOf(node)}`, 1]]);
  let frontier = elementChildren(node);
  for (let depth = 1; depth <= SIGNATURE_DEPTH && frontier.length > 0; depth += 1) {
    const next: PageNode[] = [];
    for (const child of frontier) {
      const tag = tagOf(child);
      signature.set(tag, (signature.get(tag) ?? 0) + 1);
      next.push(...elementChildren(child));
    }
    frontier = next;
  }
  return signature;
}

/** The most frequent signature; when none repeats, the medoid of a bounded sample. */
function modalSignature(
  children: readonly PageNode[],
  signatureOf: (node: PageNode) => Map<string, number>,
): Map<string, number> {
  const counts = new Map<string, { count: number; signature: Map<string, number> }>();
  for (const child of children) {
    const signature = signatureOf(child);
    const key = JSON.stringify([...signature.entries()].sort());
    const entry = counts.get(key) ?? { count: 0, signature };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { count: number; signature: Map<string, number> } | undefined;
  for (const entry of counts.values())
    if (best === undefined || entry.count > best.count) best = entry;
  if (best !== undefined && best.count > 1) return best.signature;
  const sample = children.slice(0, MEDOID_SAMPLE).map(signatureOf);
  let medoid = sample[0] ?? new Map<string, number>();
  let bestTotal = -1;
  for (const candidate of sample) {
    const total = sample.reduce((sum, other) => sum + jaccard(candidate, other), 0);
    if (total > bestTotal) {
      bestTotal = total;
      medoid = candidate;
    }
  }
  return medoid;
}

/** Multiset Jaccard similarity: Σ min / Σ max. */
function jaccard(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): number {
  let shared = 0;
  let union = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key) ?? 0;
    const b = right.get(key) ?? 0;
    shared += Math.min(a, b);
    union += Math.max(a, b);
  }
  return union === 0 ? 0 : shared / union;
}

/** The anchor wrapping or nearest the first heading, else the anchor with the longest text. */
function primaryAnchor(
  index: PageIndex,
  item: PageNode,
  anchors: readonly PageNode[],
): PageNode | null {
  if (anchors.length === 0) return null;
  const heading = index.within(item, (node) => HEADING_TAGS.has(tagOf(node)))[0];
  if (heading !== undefined) {
    const wrapping = anchors.find(
      (anchor) => contains(anchor, heading) || contains(heading, anchor),
    );
    if (wrapping !== undefined) return wrapping;
    const headingOrder = index.factsOf(heading).order;
    const after = anchors.find((anchor) => index.factsOf(anchor).order > headingOrder);
    return after ?? anchors[anchors.length - 1] ?? null;
  }
  let longest: PageNode | null = null;
  let longestLength = -1;
  for (const anchor of anchors) {
    const length = index.textOf(anchor).length;
    if (length > longestLength) {
      longest = anchor;
      longestLength = length;
    }
  }
  return longest;
}

/** One record read plus what bounding did to it. */
interface RecordRead {
  readonly record: PageRecord;
  readonly truncated: boolean;
  readonly chars: number;
}

/**
 * Reads one record. Text that became a field (a `dt`/`dd` pair, a two-cell
 * row, a "Label: value" run) is a field rather than also a segment, so the
 * per-record bound is not spent twice on the same words.
 */
function readRecord(
  index: PageIndex,
  item: PageNode,
  primary: PageNode | null,
  anchors: readonly PageNode[],
  links: ReadonlyMap<PageNode, LinkCandidate>,
): RecordRead {
  const sourced: SourcedField[] = [
    ...definitionPairs(index, item),
    ...index
      .within(item, (node) => tagOf(node) === 'tr')
      .map((row) => cellPair(index, row))
      .filter((pair): pair is SourcedField => pair !== null),
  ];
  const fieldNodes = new Set(sourced.flatMap((pair) => pair.nodes));
  const fields: PageField[] = sourced.map((pair) => pair.field);

  const heading = index.within(item, (node) => HEADING_TAGS.has(tagOf(node)))[0];
  const primaryLink = primary === null ? undefined : links.get(primary);
  const runs = index.runsOf(item, { exclude: (node) => fieldNodes.has(node) });
  const titleText =
    (heading === undefined ? '' : index.textOf(heading)) ||
    (primary === null ? '' : index.textOf(primary)) ||
    (runs[0] ?? '');

  const segments: string[] = [];
  const seen = new Set<string>([normalizeKey(titleText)]);
  for (const run of runs) {
    const key = normalizeKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    const field = parseLabelValue(run);
    if (field !== null) {
      fields.push(field);
      continue;
    }
    segments.push(run);
  }

  // Bound title + segments + field values at a segment boundary.
  let budget = RECORD_TEXT_CHARS;
  let truncated = false;
  const title = titleText.length === 0 ? null : titleText.slice(0, budget);
  budget -= title?.length ?? 0;
  if (title !== null && title.length < titleText.length) truncated = true;
  const keptSegments: string[] = [];
  for (const segment of segments) {
    if (segment.length > budget) {
      truncated = true;
      break;
    }
    keptSegments.push(segment);
    budget -= segment.length;
  }
  const keptFields: PageField[] = [];
  for (const field of fields.slice(0, RECORD_FIELDS_MAX)) {
    if (field.value.length > budget) {
      truncated = true;
      break;
    }
    keptFields.push(field);
    budget -= field.value.length;
  }
  if (fields.length > RECORD_FIELDS_MAX) truncated = true;

  const shownText = [title ?? '', ...keptSegments, ...keptFields.map((field) => field.value)];
  const numbers = numericTokens(shownText.join('\n'));

  const primaryKey = primaryLink === undefined ? null : primaryLink.canonical;
  const secondary: RecordLink[] = [];
  const linkKeys = new Set<string>(primaryKey === null ? [] : [primaryKey]);
  for (const anchor of anchors) {
    const target = links.get(anchor);
    if (target === undefined || linkKeys.has(target.canonical)) continue;
    linkKeys.add(target.canonical);
    if (secondary.length < RECORD_LINKS_MAX) secondary.push({ text: target.text, url: target.url });
  }

  const key =
    primaryLink === undefined
      ? `h:${createHash('sha256')
          .update(JSON.stringify([normalizeKey(titleText), normalizeKey(segments[0] ?? '')]))
          .digest('hex')
          .slice(0, 16)}`
      : canonicalUrl(primaryLink.url);

  return {
    record: {
      key,
      title,
      url: primaryLink?.url ?? null,
      segments: keptSegments,
      fields: keptFields,
      numbers,
      links: secondary,
    },
    truncated,
    chars: shownText.reduce((total, text) => total + text.length, 0),
  };
}

function normalizeKey(text: string): string {
  return cleanRun(text).toLowerCase();
}
