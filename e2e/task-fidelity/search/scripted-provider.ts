/**
 * `ScriptedSearchProvider`: deterministic SERPs pointing at the fixture sites,
 * with fault injection (FEAT-049 TASK-004).
 *
 * It implements the production `SearchProvider` contract and is injected
 * through the run's `resolveSearchProvider` leaf, so everything above it — the
 * `web_search` tool, its error classification, the run-health ledger, and
 * whatever FEAT-050 puts between them — runs as production code.
 *
 * Faults throw the REAL core error classes, never structural doubles: the
 * classification the harness measures is then production's classification
 * (memory → Testing: a hand-rolled stand-in hides the renderer bug it exists to
 * catch).
 */

import {
  ScrapeSearchError,
  type SearchProvider,
  type SearchProviderName,
  type SearchResult,
} from '@yantra/core';
import { ok, type Result } from '@yantra/protocol';

/** One scripted SERP: queries matching `match` return `results`. */
export interface ScriptedSerpEntry {
  /** A case-insensitive substring, or a pattern tested against the query. */
  readonly match: string | RegExp;
  readonly results: readonly SerpHit[];
}

/** A scripted search hit. Rank and source are assigned by the provider. */
export interface SerpHit {
  readonly url: string;
  readonly title: string;
  readonly snippet?: string;
}

/**
 * A fault to inject.
 *
 * - `challenge-on-concurrency`: a call that starts while another is in flight
 *   is answered with an anti-bot challenge. This models G4, where every
 *   failure fell inside a concurrent pair of searches.
 * - `challenge`, `empty`, `timeout`: the listed 1-based calls fail that way.
 */
export type SearchFault =
  | { readonly kind: 'challenge-on-concurrency' }
  | { readonly kind: 'challenge'; readonly onCall: readonly number[] }
  | { readonly kind: 'empty'; readonly onCall: readonly number[] }
  | { readonly kind: 'timeout'; readonly onCall: readonly number[] };

/** How one call ended. */
export type SearchCallOutcome =
  'ok' | 'unmatched' | 'discovery' | 'challenge' | 'empty' | 'timeout' | 'aborted';

/** One provider call, as the harness observed it. */
export interface SearchCallRecord {
  /** 1-based call order. */
  readonly call: number;
  readonly query: string;
  readonly limit: number;
  /** Injected monotonic clock, ms. */
  readonly startedAt: number;
  /** Null while the call is still in flight. */
  readonly endedAt: number | null;
  /** Null while the call is still in flight. */
  readonly outcome: SearchCallOutcome | null;
  /** The most calls in flight at once at any moment during this call. */
  readonly peakConcurrency: number;
}

export interface ScriptedSearchProviderOptions {
  readonly serps: readonly ScriptedSerpEntry[];
  readonly faults?: readonly SearchFault[];
  /** A real provider name: the union is closed. Fault scenarios use `duckduckgo`. */
  readonly name?: SearchProviderName;
  /** Simulated latency of a successful call, so concurrent calls genuinely overlap. */
  readonly latencyMs?: number;
  /** How long a `timeout` fault waits before rejecting with the provider's timeout code. */
  readonly timeoutMs?: number;
  /** Monotonic clock for the call log. */
  readonly now?: () => number;
}

const DEFAULT_LATENCY_MS = 25;
const DEFAULT_TIMEOUT_MS = 250;

interface MutableCall {
  call: number;
  query: string;
  limit: number;
  startedAt: number;
  endedAt: number | null;
  outcome: SearchCallOutcome | null;
  peakConcurrency: number;
}

/** A deterministic, fault-injecting search provider for the task-fidelity harness. */
export class ScriptedSearchProvider implements SearchProvider {
  public readonly name: SearchProviderName;
  private readonly serps: readonly ScriptedSerpEntry[];
  private readonly faults: readonly SearchFault[];
  private readonly latencyMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: MutableCall[] = [];
  private readonly inFlight = new Set<MutableCall>();

  public constructor(options: ScriptedSearchProviderOptions) {
    this.name = options.name ?? 'duckduckgo';
    this.serps = options.serps;
    this.faults = options.faults ?? [];
    this.latencyMs = options.latencyMs ?? DEFAULT_LATENCY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => performance.now());
  }

  public async search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    const record: MutableCall = {
      call: this.log.length + 1,
      query,
      limit: opts.limit,
      startedAt: this.now(),
      endedAt: null,
      outcome: null,
      peakConcurrency: 0,
    };
    const overlapped = this.inFlight.size > 0;
    this.log.push(record);
    this.inFlight.add(record);
    for (const call of this.inFlight) {
      call.peakConcurrency = Math.max(call.peakConcurrency, this.inFlight.size);
    }
    try {
      return await this.answer(record, overlapped, opts);
    } finally {
      this.inFlight.delete(record);
      record.endedAt = this.now();
    }
  }

  /** A snapshot of every call so far, in start order. */
  public calls(): readonly SearchCallRecord[] {
    return this.log.map((call) => ({ ...call }));
  }

  /** The most calls that were ever in flight at once. */
  public peakConcurrency(): number {
    return this.log.reduce((peak, call) => Math.max(peak, call.peakConcurrency), 0);
  }

  /** The calls a fault fired on, in call order. */
  public faultedCalls(): readonly SearchCallRecord[] {
    return this.calls().filter(
      (call) =>
        call.outcome === 'challenge' || call.outcome === 'empty' || call.outcome === 'timeout',
    );
  }

  private async answer(
    record: MutableCall,
    overlapped: boolean,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]> {
    // Discovery mode is the caller's to implement: the provider never pretends
    // to support it by consulting its table for a zero-result request.
    if (opts.limit <= 0) {
      record.outcome = 'discovery';
      return [];
    }
    const fault = this.faultFor(record.call, overlapped);
    if (fault === 'challenge') {
      record.outcome = 'challenge';
      throw new ScrapeSearchError('The search provider served an anti-bot challenge.', {
        provider: this.name,
        host: 'search.yantra.test',
        code: 'anomaly-challenge',
      });
    }
    if (fault === 'empty') {
      record.outcome = 'empty';
      throw new ScrapeSearchError('The search provider returned no results.', {
        provider: this.name,
        host: 'search.yantra.test',
        code: 'empty-results',
      });
    }
    if (fault === 'timeout') {
      const aborted = await this.waitForTimeout(opts.signal);
      record.outcome = aborted ? 'aborted' : 'timeout';
      throw aborted
        ? new ScrapeSearchError('Search aborted.', {
            provider: this.name,
            host: 'search.yantra.test',
            code: 'aborted',
          })
        : new ScrapeSearchError('The search provider timed out.', {
            provider: this.name,
            host: 'search.yantra.test',
            code: 'timeout',
          });
    }

    await delay(this.latencyMs, opts.signal);
    if (opts.signal.aborted) {
      record.outcome = 'aborted';
      throw new ScrapeSearchError('Search aborted.', {
        provider: this.name,
        host: 'search.yantra.test',
        code: 'aborted',
      });
    }
    const entry = this.serps.find((candidate) => matches(candidate.match, record.query));
    if (entry === undefined) {
      record.outcome = 'unmatched';
      return [];
    }
    record.outcome = 'ok';
    return entry.results.slice(0, opts.limit).map((hit, index) => ({
      url: hit.url,
      title: hit.title,
      snippet: hit.snippet ?? null,
      source: this.name,
      rank: index + 1,
      publishedAt: null,
    }));
  }

  private faultFor(call: number, overlapped: boolean): 'challenge' | 'empty' | 'timeout' | null {
    for (const fault of this.faults) {
      if (fault.kind === 'challenge-on-concurrency') {
        if (overlapped) return 'challenge';
      } else if (fault.onCall.includes(call)) {
        return fault.kind;
      }
    }
    return null;
  }

  /** Resolve true when the signal aborts first, false when the provider's own timeout fires. */
  private waitForTimeout(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(false);
      }, this.timeoutMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** The run's `resolveSearchProvider` leaf for a scripted provider. */
export function scriptedSearchLeaf(
  provider: ScriptedSearchProvider,
): () => Promise<Result<SearchProvider, never>> {
  return () => Promise.resolve(ok(provider));
}

function matches(match: string | RegExp, query: string): boolean {
  return typeof match === 'string'
    ? query.toLowerCase().includes(match.toLowerCase())
    : match.test(query);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
