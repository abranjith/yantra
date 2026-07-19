/**
 * Combined web research loop: `search → fetch → extract` in one pass.
 *
 * This is the **shared evidence path** the plan (§7) calls for: the agentic
 * `web_search` tool and the deterministic `--no-llm` pipeline both fetch and
 * extract search hits through the very same {@link processSource} stage, so
 * there is exactly one fetch/ethics/extraction behavior across both flows
 * (memory §Architecture: the core loop lives in `@yantra/core` as an ordinary
 * function; the Pi adapter wrapper stays thin).
 *
 * The function runs the provider search, then fetches + extracts the top-N hits
 * **in parallel** with strict per-source failure isolation — an ethics refusal,
 * a fetch timeout, or an unreadable page degrades to a {@link SourceFailure}
 * carried on its {@link ProcessedSource}, never a rejected batch. The unfetched
 * tail is returned as snippet-only {@link SearchResult}s so a caller can present
 * "more results" without another round trip.
 *
 * No sanitization happens here — the agent middleware owns the LLM-bound
 * sanitizer chokepoint. No ethics bypass exists — each {@link processSource}
 * call runs the injected gate for its URL.
 */

import type { SearchProvider } from './search/registry.js';
import {
  processSource,
  type ProcessedSource,
  type SourceProcessorDeps,
} from './source-processor.js';
import type { SearchResult } from './types.js';

/** Injected dependencies for {@link webResearch}: the per-source stages plus a provider. */
export interface WebResearchDeps extends SourceProcessorDeps {
  /** The resolved search provider for this call. */
  readonly provider: SearchProvider;
}

/** Per-call options controlling breadth, depth, timeout, and cancellation. */
export interface WebResearchOptions {
  /** How many of the top hits to fetch + extract (the rest become `remaining`). */
  readonly fetchTop: number;
  /** How many hits to request from the provider (the search-result breadth). */
  readonly resultCap: number;
  /** Per-fetch timeout in milliseconds, applied to each parallel fetch. */
  readonly perFetchTimeoutMs: number;
  /** Cancellation signal (budget/abort) threaded into every fetch. */
  readonly signal: AbortSignal;
}

/**
 * The outcome of one combined research call: the fetched+extracted top hits
 * (each carrying either a doc or a failure) and the unfetched snippet-only tail.
 * Both arrays preserve search-rank order.
 */
export interface WebResearchOutcome {
  /** Top-N hits after fetch/extract, in search-rank order. */
  readonly processed: readonly ProcessedSource[];
  /** The unfetched tail (rank `fetchTop + 1 …`), snippet-only. */
  readonly remaining: readonly SearchResult[];
}

/**
 * Search the web and fetch+extract the top-N hits through the shared per-source
 * pipeline.
 *
 * @param deps - The ethics gate, fetcher, extractor, and resolved provider.
 * @param query - The search query as it should be executed.
 * @param opts - Breadth (`resultCap`), depth (`fetchTop`), timeout, and signal.
 * @returns The processed top hits and the unfetched remaining tail. Never
 *   throws for a per-source failure — those live on the returned
 *   {@link ProcessedSource}s. A provider search throw propagates to the caller.
 *
 * @example
 * const { processed, remaining } = await webResearch(
 *   { ethicsGate, fetcher, extractor, provider },
 *   'best mirrorless cameras 2026',
 *   { fetchTop: 3, resultCap: 8, perFetchTimeoutMs: 8000, signal },
 * );
 */
export async function webResearch(
  deps: WebResearchDeps,
  query: string,
  opts: WebResearchOptions,
): Promise<WebResearchOutcome> {
  const hits = await deps.provider.search(query, { limit: opts.resultCap, signal: opts.signal });

  const top = hits.slice(0, opts.fetchTop);
  const remaining = hits.slice(opts.fetchTop);

  // Parallel fetch with per-source isolation: `processSource` never throws, so
  // one blocked/timed-out/empty source cannot reject the batch. `Promise.all`
  // preserves input order, keeping both arrays in search-rank order.
  const processed = await Promise.all(
    top.map((hit) =>
      processSource(deps, hit, {
        perFetchTimeoutMs: opts.perFetchTimeoutMs,
        signal: opts.signal,
      }),
    ),
  );

  return { processed, remaining };
}
