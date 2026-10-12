/**
 * The run document store (FEAT-050): the one owner of evidence identity.
 *
 * Run `20260925T130634Z` fetched one results page seven times and spent 9 of
 * its 30 navigations re-reading pages it already had, because nothing in the
 * run remembered what it had read. The store is that memory. Every web read in
 * an agentic run goes through {@link DocumentStore.read}, which answers from
 * the store when it can and loads from the network only when it must:
 *
 * 1. a page already read (by its canonical requested **or** final URL) is a
 *    `hit` — no network, no navigation charged;
 * 2. a URL whose earlier read failed for a reason that cannot change within
 *    the run is answered from the failure memo;
 * 3. a URL whose load is already in flight is awaited, not loaded twice;
 * 4. only then is `load` called.
 *
 * Each page read successfully gets a run-wide evidence ID (`S1`, `S2`, …),
 * minted once, in first-success order. Failures never mint, so IDs stay dense.
 * The ID is what `web_search`, `web_fetch`, `browser_extract`, and the
 * evidence ledger all show, so a later citation can name a page unambiguously.
 *
 * The store holds no page text and does no I/O of its own: `load` is the
 * caller's fetch, and the store only decides whether to call it.
 */

import { EthicsRefusedError } from '../executor/errors.js';

import { FetchError } from './fetcher.js';
import { canonicalUrl } from './url-identity.js';

/** How a stored page was obtained. `observed` means a browser already showed it. */
export type DocumentFetchMode = 'http' | 'browser' | 'observed';

/** The tools that read pages into the store. */
export type DocumentTool = 'web_search' | 'web_fetch' | 'browser_extract';

/** One page read successfully in this run. */
export interface DocumentRecord {
  /** Run-wide evidence ID (`S<n>`), unique and dense. */
  readonly sourceId: string;
  /** Canonical identity of the URL as first requested. */
  readonly canonicalUrl: string;
  /** The URL as first requested. */
  readonly url: string;
  /** The post-redirect URL, when it differs from {@link url}. */
  readonly finalUrl: string | null;
  /** Page title, when one was extracted. */
  readonly title: string | null;
  /** How the page was obtained. */
  readonly fetchMode: DocumentFetchMode;
  /** The tool whose read minted the ID. */
  readonly firstTool: DocumentTool;
  /** ISO-8601 time of the first successful read. */
  readonly firstReadAt: string;
  /** Run-relative capture reference, when the content was stored as a capture. */
  readonly captureRef: string | null;
  /** The first read plus each repeat served from the store. */
  readonly reads: number;
}

/** Facts about a successful load, recorded on the minted {@link DocumentRecord}. */
export interface LoadedMeta {
  readonly url: string;
  readonly finalUrl: string | null;
  readonly title: string | null;
  readonly fetchMode: 'http' | 'browser';
  readonly tool: DocumentTool;
}

/**
 * What a caller's `load` reports. A failure says whether it is `terminal`
 * (cannot change within the run, see {@link isTerminalFetchFailure}); only
 * terminal failures are memoized. `failure` is the caller's own payload,
 * replayed verbatim when the memo answers a later read.
 */
export type LoadOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly meta: LoadedMeta }
  | {
      readonly ok: false;
      readonly terminal: boolean;
      readonly code: string;
      readonly reason: string;
      readonly failure: unknown;
    };

/** The answer to one {@link DocumentStore.read}. */
export type StoreRead<T> =
  /** This call loaded the page; `value` is the load's own value. */
  | { readonly kind: 'fetched'; readonly record: DocumentRecord; readonly value: T }
  /** The page was already read in this run; nothing was loaded for this call. */
  | { readonly kind: 'hit'; readonly record: DocumentRecord }
  /**
   * The read failed. `memoized` is true when the failure was answered from
   * the memo (or shared from a concurrent terminal load), so no load ran.
   */
  | {
      readonly kind: 'failed';
      readonly code: string;
      readonly reason: string;
      readonly failure: unknown;
      readonly memoized: boolean;
    };

/** A remembered terminal failure for one canonical URL. */
export interface FailureMemo {
  readonly code: string;
  readonly reason: string;
  readonly failure: unknown;
}

/** Counters for the run-health summary. */
export interface DocumentStoreStats {
  /** Calls to a caller's `load` (one per real network read attempt). */
  readonly networkLoads: number;
  /** Reads answered from an existing record, including single-flight joins. */
  readonly hits: number;
  /** Reads answered from the failure memo. */
  readonly memoHits: number;
  /** Pages recorded by {@link DocumentStore.observe}. */
  readonly observed: number;
}

/**
 * Content the run fetched but will not use, for a reason that cannot change
 * within the run. Raised (or constructed) by a caller so
 * {@link isTerminalFetchFailure} can classify it alongside fetch errors.
 */
export class UnreadableContentError extends Error {
  public override readonly name = 'UnreadableContentError';

  public constructor(public readonly kind: 'content-type-refused' | 'extraction-empty') {
    super(
      kind === 'content-type-refused'
        ? 'The response is not a text content type.'
        : 'No readable content could be extracted.',
    );
  }
}

/**
 * Whether a read failure cannot change within the run, so retrying it is
 * pointless and it may be answered from the memo. This is the single place the
 * list lives:
 *
 * - HTTP 4xx other than 408 (request timeout) and 429 (rate limited);
 * - a body over the size limit;
 * - a challenge page (FEAT-050 policy b: a browser-tier challenge is terminal);
 * - a refused content type, or a page with no extractable content;
 * - an ethics refusal by robots.txt or the blocklist.
 *
 * Timeouts, network errors, 5xx, 408/429, rate-limit refusals, and the run's
 * own budget refusals are never terminal: each can clear within the run.
 *
 * @param error The failure behind a read (any value; unknown shapes are not terminal).
 */
export function isTerminalFetchFailure(error: unknown): boolean {
  if (error instanceof FetchError) {
    switch (error.context.kind) {
      case 'http-status': {
        const status = error.context.statusCode;
        return (
          status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
        );
      }
      case 'too-large':
      case 'challenge':
        return true;
      case 'timeout':
      case 'network':
        return false;
    }
  }
  if (error instanceof UnreadableContentError) return true;
  if (error instanceof EthicsRefusedError) {
    return error.ethicsContext.source === 'robots' || error.ethicsContext.source === 'blocklist';
  }
  return false;
}

/** Mutable internal record; callers only ever see frozen snapshots. */
interface MutableRecord {
  sourceId: string;
  canonicalUrl: string;
  url: string;
  finalUrl: string | null;
  title: string | null;
  fetchMode: DocumentFetchMode;
  firstTool: DocumentTool;
  firstReadAt: string;
  captureRef: string | null;
  reads: number;
}

/** What an in-flight load settles to, shared with concurrent readers. */
type Settled =
  | { readonly kind: 'record'; readonly record: MutableRecord }
  | { readonly kind: 'failed'; readonly outcome: Extract<LoadOutcome<unknown>, { ok: false }> };

/**
 * One per run. Constructed by the orchestrator next to the evidence ledger and
 * required on `RunServices`, because a forgotten construction site would
 * silently disable the read-once guarantee.
 */
export class DocumentStore {
  private readonly records: MutableRecord[] = [];
  private readonly index = new Map<string, MutableRecord>();
  private readonly memo = new Map<string, FailureMemo>();
  private readonly inFlight = new Map<string, Promise<Settled>>();
  private networkLoads = 0;
  private hits = 0;
  private memoHits = 0;
  private observedCount = 0;

  /**
   * @param nowIso ISO-8601 clock for `firstReadAt` (injectable for tests).
   */
  public constructor(private readonly nowIso: () => string = () => new Date().toISOString()) {}

  /**
   * Read one URL through the store.
   *
   * @param url The URL as the caller will fetch it.
   * @param load The caller's network read; called at most once per canonical URL
   *   unless an earlier load failed non-terminally.
   * @returns `fetched` (this call loaded it), `hit` (already read), or `failed`.
   * @throws Whatever `load` throws unexpectedly; such a failure is never memoized.
   */
  public async read<T>(url: string, load: () => Promise<LoadOutcome<T>>): Promise<StoreRead<T>> {
    const key = canonicalUrl(url);
    const existing = this.index.get(key);
    if (existing !== undefined) return this.hit(existing);

    const remembered = this.memo.get(key);
    if (remembered !== undefined) {
      this.memoHits += 1;
      return { kind: 'failed', ...remembered, memoized: true };
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) {
      const settled = await pending;
      if (settled.kind === 'record') return this.hit(settled.record);
      const { code, reason, failure, terminal } = settled.outcome;
      if (terminal) this.memoHits += 1;
      return { kind: 'failed', code, reason, failure, memoized: terminal };
    }

    const settling = this.runLoad(key, load);
    const shared = settling.then((result) => result.settled);
    // Joiners await `shared`; this handler only keeps a load that throws with
    // no joiner from surfacing as an unhandled rejection. The caller below
    // still receives the throw through `settling`.
    shared.catch(() => undefined);
    this.inFlight.set(key, shared);
    try {
      const result = await settling;
      if (result.settled.kind === 'failed') {
        const { code, reason, failure } = result.settled.outcome;
        return { kind: 'failed', code, reason, failure, memoized: false };
      }
      if (!result.fresh) return this.hit(result.settled.record);
      return { kind: 'fetched', record: snapshot(result.settled.record), value: result.value as T };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Record a page the browser already shows, minting (or returning) its ID
   * without any network read. Used by `browser_extract`, which reads the live
   * page; it never answers a later `read` with stale content because the
   * record carries no content, only identity.
   *
   * @param url The page URL as the browser reports it.
   * @param meta The extracted title and the observing tool.
   */
  public observe(
    url: string,
    meta: { readonly title: string | null; readonly tool: DocumentTool },
  ): DocumentRecord {
    const key = canonicalUrl(url);
    const existing = this.index.get(key);
    if (existing !== undefined) {
      existing.reads += 1;
      return snapshot(existing);
    }
    this.observedCount += 1;
    const record = this.mint(key, {
      url,
      finalUrl: null,
      title: meta.title,
      fetchMode: 'observed',
      tool: meta.tool,
    });
    return snapshot(record);
  }

  /** Attach a capture reference to a record (first capture wins). */
  public attachCapture(sourceId: string, ref: string): void {
    const record = this.records.find((entry) => entry.sourceId === sourceId);
    if (record?.captureRef === null) record.captureRef = ref;
  }

  /** The record for an evidence ID, or null. */
  public get(sourceId: string): DocumentRecord | null {
    const record = this.records.find((entry) => entry.sourceId === sourceId);
    return record === undefined ? null : snapshot(record);
  }

  /** The record a URL resolves to (by requested or final canonical URL), or null. */
  public lookup(url: string): DocumentRecord | null {
    const record = this.index.get(canonicalUrl(url));
    return record === undefined ? null : snapshot(record);
  }

  /** Every record, in mint order. */
  public entries(): readonly DocumentRecord[] {
    return this.records.map(snapshot);
  }

  /** Counters for run health. */
  public stats(): DocumentStoreStats {
    return {
      networkLoads: this.networkLoads,
      hits: this.hits,
      memoHits: this.memoHits,
      observed: this.observedCount,
    };
  }

  private hit(record: MutableRecord): StoreRead<never> {
    record.reads += 1;
    this.hits += 1;
    return { kind: 'hit', record: snapshot(record) };
  }

  /**
   * Run one load and fold its outcome into the store. `fresh` is false when
   * the page landed on a URL already recorded (a redirect into a page read
   * earlier), in which case the existing record answers and no ID is minted.
   */
  private async runLoad<T>(
    key: string,
    load: () => Promise<LoadOutcome<T>>,
  ): Promise<{ readonly settled: Settled; readonly fresh: boolean; readonly value?: T }> {
    this.networkLoads += 1;
    const outcome = await load();
    if (!outcome.ok) {
      if (outcome.terminal) {
        this.memo.set(key, {
          code: outcome.code,
          reason: outcome.reason,
          failure: outcome.failure,
        });
      }
      return { settled: { kind: 'failed', outcome }, fresh: false };
    }
    const finalKey = outcome.meta.finalUrl === null ? null : canonicalUrl(outcome.meta.finalUrl);
    const landed = finalKey === null ? undefined : this.index.get(finalKey);
    if (landed !== undefined) {
      this.index.set(key, landed);
      return { settled: { kind: 'record', record: landed }, fresh: false };
    }
    const record = this.mint(key, outcome.meta);
    if (finalKey !== null && finalKey !== key) this.index.set(finalKey, record);
    return { settled: { kind: 'record', record }, fresh: true, value: outcome.value };
  }

  private mint(
    key: string,
    meta: {
      readonly url: string;
      readonly finalUrl: string | null;
      readonly title: string | null;
      readonly fetchMode: DocumentFetchMode;
      readonly tool: DocumentTool;
    },
  ): MutableRecord {
    const record: MutableRecord = {
      sourceId: `S${this.records.length + 1}`,
      canonicalUrl: key,
      url: meta.url,
      finalUrl: meta.finalUrl !== null && meta.finalUrl !== meta.url ? meta.finalUrl : null,
      title: meta.title,
      fetchMode: meta.fetchMode,
      firstTool: meta.tool,
      firstReadAt: this.nowIso(),
      captureRef: null,
      reads: 1,
    };
    this.records.push(record);
    this.index.set(key, record);
    return record;
  }
}

function snapshot(record: MutableRecord): DocumentRecord {
  return Object.freeze({ ...record });
}
