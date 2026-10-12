/**
 * One search service per run (FEAT-050, G4).
 *
 * Run `20260925T130634Z` built 22 search providers for its 22 `web_search`
 * calls and logged "selected search provider" 22 times. With no object owning
 * the provider, nothing could serialize a scraped provider or stop after it
 * challenged us: the model searched in concurrent pairs, and 11 of 22 failed —
 * every failure inside a pair.
 *
 * The service is that owner. It resolves the provider once (memoized,
 * including a failed resolution: configuration cannot change mid-run) and
 * hands back a **gated facade** with the same name, whose `search()`:
 *
 * 1. refuses immediately with {@link SearchCircuitOpenError} once the breaker
 *    is open — no provider call, no wait, no browser;
 * 2. otherwise waits for a slot under {@link SEARCH_POLITENESS} for the
 *    provider's kind (an abort while queued rejects with no provider call);
 * 3. waits until `minIntervalMs` has passed since the previous provider call
 *    started;
 * 4. calls the provider;
 * 5. opens the breaker on an anti-bot challenge or a rate limit, logs one
 *    `search_breaker_open` warning, and rethrows the original error so the
 *    first call still reports its true cause.
 *
 * Every other error passes through untouched and never opens the breaker.
 * Serializing a scraped provider and stopping at its first challenge is how a
 * run honors that provider's rate limiting; nothing here rotates identity,
 * proxies, or retries (plan §6).
 */

import type { Result } from '@yantra/protocol';
import { ok } from '@yantra/protocol';

import { abortError } from '../../browser/page-source.js';
import type { Logger } from '../../browser/types.js';

import {
  RateLimitError,
  ScrapeSearchError,
  SearchCircuitOpenError,
  type SearchProviderError,
} from './errors.js';
import { SEARCH_PROVIDER_REGISTRY, type SearchProvider } from './registry.js';

/** How a provider kind may be asked: concurrency and spacing between calls. */
export interface SearchPoliteness {
  readonly maxConcurrent: number;
  readonly minIntervalMs: number;
}

/**
 * Politeness by provider kind (G4). A scraped provider is one browser asking a
 * public results page, so it is asked one query at a time, two seconds apart;
 * a keyed API provider is a contracted service and may take two at once.
 * Named constants, not user configuration: re-tune only on harness evidence
 * (plan §12 item 7).
 */
export const SEARCH_POLITENESS: Readonly<Record<'scrape' | 'api', SearchPoliteness>> =
  Object.freeze({
    scrape: Object.freeze({ maxConcurrent: 1, minIntervalMs: 2_000 }),
    api: Object.freeze({ maxConcurrent: 2, minIntervalMs: 0 }),
  });

/** The run's challenge breaker. */
export interface SearchBreaker {
  readonly open: boolean;
  readonly openedBy: 'anomaly-challenge' | 'rate-limited' | null;
  readonly openedAt: string | null;
  /** Searches refused because the breaker was open. */
  readonly skipped: number;
}

/** Counters for the run-health summary. */
export interface SearchServiceStats {
  /** Searches asked of the facade. */
  readonly calls: number;
  /** Searches that reached the provider. */
  readonly providerCalls: number;
  /** Provider calls that ended in a challenge or rate limit. */
  readonly challenges: number;
  /** Searches refused by the open breaker. */
  readonly breakerSkipped: number;
  /** Most provider calls in flight at once. */
  readonly peakConcurrency: number;
}

/** Construction options. */
export interface SearchServiceOptions {
  /** Resolves the run's provider (the `resolveSearchProvider` leaf, deps bound). */
  readonly resolve: () => Promise<Result<SearchProvider, SearchProviderError>>;
  /** Receives the one `search_breaker_open` warning. */
  readonly logger: Logger;
  /** Millisecond clock; injectable for tests. */
  readonly now?: () => number;
  /** Cancelable delay; injectable for tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (reason: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

/** One per run. */
export class SearchService {
  private readonly resolver: SearchServiceOptions['resolve'];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  private resolution: Promise<Result<SearchProvider, SearchProviderError>> | null = null;
  private breakerState: {
    open: boolean;
    openedBy: SearchBreaker['openedBy'];
    openedAt: string | null;
    skipped: number;
  } = { open: false, openedBy: null, openedAt: null, skipped: 0 };
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private lastStart: number | null = null;
  private calls = 0;
  private providerCalls = 0;
  private challenges = 0;
  private peak = 0;

  public constructor(options: SearchServiceOptions) {
    this.resolver = options.resolve;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? cancelableSleep;
  }

  /**
   * The run's provider, behind the gate and the breaker. Memoized: the
   * resolver runs once per run, success or failure.
   */
  public resolve(): Promise<Result<SearchProvider, SearchProviderError>> {
    this.resolution ??= this.resolver().then((resolved) =>
      resolved.isOk ? ok(this.facade(resolved.value)) : resolved,
    );
    return this.resolution;
  }

  /** The breaker's current state. */
  public breaker(): SearchBreaker {
    return { ...this.breakerState };
  }

  /** Counters for run health. */
  public stats(): SearchServiceStats {
    return {
      calls: this.calls,
      providerCalls: this.providerCalls,
      challenges: this.challenges,
      breakerSkipped: this.breakerState.skipped,
      peakConcurrency: this.peak,
    };
  }

  private facade(provider: SearchProvider): SearchProvider {
    const politeness = SEARCH_POLITENESS[SEARCH_PROVIDER_REGISTRY[provider.name].kind];
    return {
      name: provider.name,
      search: (query, opts) => this.gatedSearch(provider, politeness, query, opts),
    };
  }

  private async gatedSearch(
    provider: SearchProvider,
    politeness: SearchPoliteness,
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): ReturnType<SearchProvider['search']> {
    this.calls += 1;
    this.refuseIfOpen(provider);
    await this.acquire(politeness.maxConcurrent, opts.signal);
    try {
      if (this.lastStart !== null && politeness.minIntervalMs > 0) {
        const wait = this.lastStart + politeness.minIntervalMs - this.now();
        if (wait > 0) await this.sleep(wait, opts.signal);
      }
      // The breaker may have opened while this call waited its turn.
      this.refuseIfOpen(provider);
      this.lastStart = this.now();
      this.providerCalls += 1;
      try {
        return await provider.search(query, opts);
      } catch (error) {
        const cause = breakerCause(error);
        if (cause !== null) this.trip(provider, cause);
        throw error;
      }
    } finally {
      this.release();
    }
  }

  private refuseIfOpen(provider: SearchProvider): void {
    const { open, openedBy } = this.breakerState;
    if (!open || openedBy === null) return;
    this.breakerState.skipped += 1;
    throw new SearchCircuitOpenError(provider.name, openedBy);
  }

  private trip(provider: SearchProvider, cause: 'anomaly-challenge' | 'rate-limited'): void {
    this.challenges += 1;
    if (this.breakerState.open) return;
    this.breakerState = {
      ...this.breakerState,
      open: true,
      openedBy: cause,
      openedAt: new Date(this.now()).toISOString(),
    };
    this.logger.warn(
      { schema_version: 1, event: 'search_breaker_open', provider: provider.name, cause },
      'search breaker open',
    );
  }

  private acquire(maxConcurrent: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < maxConcurrent && this.waiters.length === 0) {
      this.take();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(signal));
        },
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next === undefined) return;
    next.signal.removeEventListener('abort', next.onAbort);
    this.take();
    next.resolve();
  }

  private take(): void {
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }
}

/** The breaker-opening cause of a provider error, or null when it must not open it. */
function breakerCause(error: unknown): 'anomaly-challenge' | 'rate-limited' | null {
  if (error instanceof ScrapeSearchError && error.context.code === 'anomaly-challenge') {
    return 'anomaly-challenge';
  }
  if (error instanceof RateLimitError) return 'rate-limited';
  return null;
}

/** A delay that rejects with the signal's reason when aborted. */
function cancelableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
