/**
 * SourcePool — the accumulating, deduplicated, diversified corpus of a
 * research run (TASK-002).
 *
 * Across hops the loop keeps discovering documents; the pool is the single
 * gate that decides which ones survive into the final synthesis. Three rules,
 * each defending the trustworthiness of the Brief:
 *
 * 1. **Exact-dup rejection** — the same page reached via two URLs (tracking
 *    params, trailing slash, fragment stripped) is kept once, so cross-source
 *    corroboration is never inflated by the same source counted twice.
 * 2. **Near-dup rejection** — syndicated copies (TF-IDF cosine ≥ the shared
 *    {@link CLUSTER_SIMILARITY_THRESHOLD}, reused from FEAT-014) collapse to
 *    one entry, for the same reason.
 * 3. **Per-host diversification** — at most {@link DEFAULT_PER_HOST_CAP}
 *    documents per host, keeping the best-ranked ones, so a single domain
 *    cannot dominate the document.
 *
 * The pool also enforces the hard `maxSources` ceiling. All checks are pure
 * over the kept set — no I/O — so the property test can hammer it with random
 * insert sequences.
 */

import { CLUSTER_SIMILARITY_THRESHOLD } from '../synthesis/clustering.js';
import { cosineSimilarity, tfidfVectors } from '../synthesis/similarity.js';
import type { SynthesisDoc, SynthesisInput, SourceFailure } from '../synthesis/types.js';

/** Default per-host document cap (plan row FEAT-017: diversification). */
export const DEFAULT_PER_HOST_CAP = 3;

/** Why a candidate document was not kept. */
export type PoolRejection = 'duplicate_url' | 'near_duplicate' | 'host_cap' | 'max_sources';

/** Outcome of one {@link SourcePool.add}. */
export interface PoolAddResult {
  /** True when the candidate was kept (possibly after evicting a worse peer). */
  readonly kept: boolean;
  /** The rejection reason when `kept` is false, else null. */
  readonly rejection: PoolRejection | null;
}

/** Constructor options; all have safe defaults. */
export interface SourcePoolOptions {
  /** Hard ceiling on total kept documents. */
  readonly maxSources: number;
  /** Per-host cap; defaults to {@link DEFAULT_PER_HOST_CAP}. */
  readonly perHostCap?: number;
  /** Near-dup cosine threshold; defaults to the shared FEAT-014 constant. */
  readonly similarityThreshold?: number;
}

/** A kept document plus its keep-priority rank (lower = better). */
interface PoolEntry {
  readonly doc: SynthesisDoc;
  readonly rank: number;
}

/**
 * Tracking / analytics query parameters stripped during URL normalization so
 * the same page linked with different campaign tags dedups to one source.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'spm',
  '_ga',
]);

/**
 * Normalizes a URL for exact-duplicate identity: lowercased host, no
 * fragment, tracking params stripped, and a trailing slash removed from a
 * non-root path. Unparseable URLs fall back to a trimmed lowercase string.
 *
 * @param raw - The URL to normalize.
 * @returns A stable identity string for duplicate detection.
 *
 * @example
 * normalizeUrl('https://A.com/x/?utm_source=n#frag'); // 'https://a.com/x'
 */
export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  for (const param of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }

  // Drop a trailing slash on non-root paths ('/a/' == '/a'), keep root '/'.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/u, '');
  }

  const query = url.searchParams.toString();
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
}

/**
 * The accumulating research corpus. Insertion is the only mutation; every
 * query method is a pure read over the kept set.
 */
export class SourcePool {
  private readonly maxSources: number;
  private readonly perHostCap: number;
  private readonly similarityThreshold: number;

  private readonly entries: PoolEntry[] = [];
  private readonly normalizedUrls = new Set<string>();

  public constructor(options: SourcePoolOptions) {
    this.maxSources = Math.max(1, options.maxSources);
    this.perHostCap = Math.max(1, options.perHostCap ?? DEFAULT_PER_HOST_CAP);
    this.similarityThreshold = options.similarityThreshold ?? CLUSTER_SIMILARITY_THRESHOLD;
  }

  /**
   * Attempts to add `doc` to the pool.
   *
   * Order of checks: exact URL dup → near-dup → per-host cap (with
   * rank-preferential eviction) → global `maxSources`. A host at cap accepts a
   * *better*-ranked candidate by evicting its worst-ranked member; the pool
   * therefore always holds the best-ranked docs per host and never exceeds
   * either cap.
   *
   * @param doc - The candidate document.
   * @param rank - Keep-priority rank (lower = better; from search rank).
   * @returns Whether the doc was kept and, if not, why.
   */
  public add(doc: SynthesisDoc, rank: number): PoolAddResult {
    const identity = normalizeUrl(doc.finalUrl ?? doc.url);
    if (this.normalizedUrls.has(identity)) {
      return { kept: false, rejection: 'duplicate_url' };
    }

    if (this.isNearDuplicate(doc.text)) {
      return { kept: false, rejection: 'near_duplicate' };
    }

    const hostEntries = this.entries.filter((entry) => entry.doc.host === doc.host);
    if (hostEntries.length >= this.perHostCap) {
      // Host is full: keep this candidate only if it out-ranks the worst peer.
      const worst = hostEntries.reduce((a, b) => (a.rank >= b.rank ? a : b));
      if (rank >= worst.rank) {
        return { kept: false, rejection: 'host_cap' };
      }
      this.evict(worst);
      this.insert(doc, rank, identity);
      return { kept: true, rejection: null };
    }

    if (this.entries.length >= this.maxSources) {
      return { kept: false, rejection: 'max_sources' };
    }

    this.insert(doc, rank, identity);
    return { kept: true, rejection: null };
  }

  /** Number of documents currently kept. */
  public size(): number {
    return this.entries.length;
  }

  /** True once the global `maxSources` ceiling is reached. */
  public isFull(): boolean {
    return this.entries.length >= this.maxSources;
  }

  /** The kept documents in rank order (best rank first), a fresh array. */
  public docs(): readonly SynthesisDoc[] {
    return [...this.entries].sort((a, b) => a.rank - b.rank).map((entry) => entry.doc);
  }

  /**
   * Builds the {@link SynthesisInput} handed to the synthesizer: the kept docs
   * in rank order plus the run's accumulated per-source failures.
   *
   * @param query - The research topic (or interim query for gap analysis).
   * @param failures - Per-source failures accumulated across hops.
   */
  public toSynthesisInput(query: string, failures: readonly SourceFailure[]): SynthesisInput {
    return { query, docs: this.docs(), failures };
  }

  /** Near-dup check: cosine ≥ threshold against any currently kept doc. */
  private isNearDuplicate(text: string): boolean {
    if (this.entries.length === 0) {
      return false;
    }
    const texts = [text, ...this.entries.map((entry) => entry.doc.text)];
    const vectors = tfidfVectors(texts);
    const candidate = vectors[0]!;
    for (let i = 1; i < vectors.length; i += 1) {
      if (cosineSimilarity(candidate, vectors[i]!) >= this.similarityThreshold) {
        return true;
      }
    }
    return false;
  }

  private insert(doc: SynthesisDoc, rank: number, identity: string): void {
    this.entries.push({ doc, rank });
    this.normalizedUrls.add(identity);
  }

  private evict(entry: PoolEntry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) {
      this.entries.splice(index, 1);
      this.normalizedUrls.delete(normalizeUrl(entry.doc.finalUrl ?? entry.doc.url));
    }
  }
}
