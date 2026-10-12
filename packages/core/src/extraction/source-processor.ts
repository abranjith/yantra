/**
 * Shared per-source fetch/extract pipeline: `ethics → fetch → extract →
 * SynthesisDoc`.
 *
 * Both the single-hop `AskPipeline` and the multi-hop research loop need the
 * exact same per-source failure isolation — an ethics refusal, a fetch
 * timeout, or an unreadable page must degrade to an honest `SourceFailure`
 * rather than abort the whole run. Extracting the logic here keeps that
 * behavior identical across both callers (memory §General: no duplicated
 * logic) while letting each caller own its own event emission and artifact
 * writes via the optional callbacks.
 */

import type { SourceFailure, SynthesisDoc } from '../synthesis/types.js';

import type { AskEthicsGate } from './ethics-adapter.js';
import { FetchError, type ContentFetcher } from './fetcher.js';
import type { PageAnalysis, PageExtraction } from './page/types.js';
import type { Extractor } from './readability.js';
import type { FetchedDoc, SearchResult } from './types.js';

/** The outcome of processing one search hit: exactly one of doc/failure is set. */
export interface ProcessedSource {
  /** Search rank of the originating hit (1-based). */
  readonly rank: number;
  /** The extracted document, or null when the source failed. */
  readonly doc: SynthesisDoc | null;
  /** The per-source failure, or null on success. */
  readonly failure: SourceFailure | null;
  /** How the page was fetched, or null when no network fetch happened. */
  readonly fetchMode: 'http' | 'browser' | null;
  /**
   * The error behind a `fetch`-stage (or challenge `blocked`) failure, kept so
   * a caller can classify it (a 404 cannot change within a run; a timeout
   * can). Absent otherwise.
   */
  readonly cause?: unknown;
  /**
   * The shape-aware analysis (FEAT-051), present only when the caller passed
   * {@link ProcessSourceOptions.extractPage} and the page was read.
   */
  readonly page?: PageAnalysis;
}

/** Injected stage dependencies shared by the pipeline callers. */
export interface SourceProcessorDeps {
  readonly ethicsGate: AskEthicsGate;
  readonly fetcher: ContentFetcher;
  readonly extractor: Extractor;
}

/** Per-call options and side-effect hooks. */
export interface ProcessSourceOptions {
  /** Per-fetch timeout in milliseconds. */
  readonly perFetchTimeoutMs: number;
  /** Cancellation signal (budget/abort). */
  readonly signal: AbortSignal;
  /**
   * Called with the raw HTML after a successful fetch so the caller can
   * persist it to the run dir. Failures here are the caller's concern.
   */
  readonly onFetchedHtml?: (url: string, html: string) => Promise<void>;
  /** Called once when a fetch times out (so the caller can emit a retry event). */
  readonly onTimeout?: () => void;
  /**
   * A shape-aware read (FEAT-051). With it, a page with no article but with
   * page parts (records, tables, fields, structured data, or links) succeeds,
   * with `doc.text` set to the page's readable text, and the analysis rides on
   * {@link ProcessedSource.page}. Without it, extraction is article-only and
   * byte-identical to before, so the deterministic `ask` and `research`
   * pipelines are unchanged.
   */
  readonly extractPage?: (doc: FetchedDoc) => Promise<PageExtraction>;
}

/**
 * Runs `ethics → fetch → extract` for one search hit, isolating every
 * failure class into a {@link SourceFailure}.
 *
 * @param deps - The ethics gate, fetcher, and extractor stages.
 * @param result - The search hit to process.
 * @param opts - Timeout, cancellation, and side-effect hooks.
 * @returns A {@link ProcessedSource} carrying either a doc or a failure,
 *   never both, never a throw.
 *
 * @example
 * const processed = await processSource(deps, hit, {
 *   perFetchTimeoutMs: 8000,
 *   signal: controller.signal,
 * });
 */
export async function processSource(
  deps: SourceProcessorDeps,
  result: SearchResult,
  opts: ProcessSourceOptions,
): Promise<ProcessedSource> {
  try {
    const ethics = await deps.ethicsGate.checkUrl(result.url);
    if (!ethics.ok) {
      // The run's own refusals keep their own stages so nothing downstream
      // (rank signals, notices) can read them as the site blocking us.
      const stage =
        ethics.reason === 'budget' ? 'budget' : ethics.reason === 'policy' ? 'policy' : 'blocked';
      return {
        rank: result.rank,
        doc: null,
        failure: sourceFailure(result.url, stage, `${ethics.reason} - ${ethics.detail}`),
        fetchMode: null,
      };
    }

    const fetched = await deps.fetcher.fetch(result.url, {
      timeoutMs: opts.perFetchTimeoutMs,
      signal: opts.signal,
    });

    if (opts.onFetchedHtml) {
      await opts.onFetchedHtml(result.url, fetched.html);
    }

    if (opts.extractPage !== undefined) {
      const { article, page } = await opts.extractPage(fetched);
      if (page.shape === null) {
        return {
          rank: result.rank,
          doc: null,
          failure: sourceFailure(result.url, 'extract', 'could not extract readable content'),
          fetchMode: fetched.fetchMode,
        };
      }
      const doc: SynthesisDoc = {
        url: result.url,
        finalUrl: fetched.finalUrl !== result.url ? fetched.finalUrl : null,
        host: safeHost(fetched.finalUrl || result.url),
        title: article?.title ?? null,
        fetchedAt: fetched.fetchedAt,
        publishedAt: article?.publishedAt ?? null,
        text: article?.contentText ?? page.readableText,
        excerpt: article?.excerpt ?? null,
      };
      return { rank: result.rank, doc, failure: null, fetchMode: fetched.fetchMode, page };
    }

    const article = await deps.extractor.extract(fetched);
    if (!article) {
      return {
        rank: result.rank,
        doc: null,
        failure: sourceFailure(result.url, 'extract', 'could not extract a readable article'),
        fetchMode: fetched.fetchMode,
      };
    }

    const doc: SynthesisDoc = {
      url: result.url,
      finalUrl: fetched.finalUrl !== result.url ? fetched.finalUrl : null,
      host: safeHost(fetched.finalUrl || result.url),
      title: article.title,
      fetchedAt: fetched.fetchedAt,
      publishedAt: article.publishedAt,
      text: article.contentText,
      excerpt: article.excerpt,
    };

    return { rank: result.rank, doc, failure: null, fetchMode: fetched.fetchMode };
  } catch (error) {
    if (error instanceof FetchError && error.context.kind === 'timeout') {
      opts.onTimeout?.();
    }
    if (error instanceof FetchError && error.context.kind === 'challenge') {
      // The site's own bot detection refused us in the standard browser
      // (FEAT-050 policy b): the page is blocked, never extracted, and the
      // `blocked` stage correctly records a negative signal about the site.
      return {
        rank: result.rank,
        doc: null,
        failure: sourceFailure(
          result.url,
          'blocked',
          `challenge page (${error.context.marker ?? 'unknown'})`,
        ),
        fetchMode: 'browser',
        cause: error,
      };
    }
    return {
      rank: result.rank,
      doc: null,
      failure: sourceFailure(result.url, 'fetch', buildFailureReason(error)),
      fetchMode: null,
      cause: error,
    };
  }
}

/** Builds a {@link SourceFailure} with a best-effort host. */
export function sourceFailure(
  url: string,
  stage: SourceFailure['stage'],
  reason: string,
): SourceFailure {
  return { url, host: safeHost(url), stage, reason };
}

/** Extracts a hostname, falling back to the raw URL on a parse error. */
function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Maps a fetch/extract error to a stable, human-readable notice reason. */
export function buildFailureReason(error: unknown): string {
  if (error instanceof FetchError) {
    if (error.context.kind === 'timeout') {
      return 'fetch timed out';
    }
    if (error.context.kind === 'http-status') {
      return `source returned HTTP ${error.context.statusCode ?? 'error'}`;
    }
    if (error.context.kind === 'too-large') {
      return 'source payload exceeded the size limit';
    }
    if (error.context.kind === 'challenge') {
      return `challenge page (${error.context.marker ?? 'unknown'})`;
    }
    return 'fetch failed';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'unexpected failure while processing source';
}
