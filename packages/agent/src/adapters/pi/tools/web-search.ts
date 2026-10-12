/**
 * `web_search` tool spec (FEAT-WI-001) — combined search-that-fetches.
 *
 * One call returns *evidence, not pointers*: the tool runs the provider search,
 * then fetches and extracts the top-N hits through the **same** `@yantra/core`
 * per-source stage the deterministic pipeline uses ({@link processSource}),
 * returning strongly-typed per-site content under run-wide evidence IDs. This
 * collapses the search → fetch → fetch → fetch chain that small local models
 * handle poorly into a single tool round trip.
 *
 * Every hit is read through the run document store (FEAT-050): a page already
 * read in this run comes back as `already_read` with its `source_id` and no
 * fetch, two searches sharing a hit fetch it once, and a navigation is charged
 * only when a real network fetch happens. `limit: 0` is discovery only: titles,
 * URLs, and snippets, with nothing fetched and nothing charged.
 *
 * Every fetched URL passes the outbound URL policy **and** the ethics gate
 * individually — there is no batching shortcut (plan §6). A per-URL refusal or
 * fetch/extract failure is surfaced as a per-site `failures` entry, never a
 * whole-tool error. The middleware owns the LLM-bound sanitizer chokepoint:
 * both snippets and fetched page content are untrusted input, sanitized and
 * byte-bounded before the model sees them.
 */

import {
  createAskEthicsAdapter,
  domainFromUrl,
  isTerminalFetchFailure,
  processSource,
  rankReasonForFailureStage,
  safeRecordRankSignal,
  type AskEthicsDecision,
  type AskEthicsGate,
  type BudgetLimitName,
  type DocumentRecord,
  type LoadOutcome,
  type ProcessedSource,
  type SearchProvider,
  type SearchResult,
  type SourceFailure,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import type { AllowedUrl } from '../../../runtime/url-policy.js';

import { writeCapture } from './capture.js';
import { mapSearchError } from './search-errors.js';

/** Absolute ceiling on the number of sites fetched+returned to the model. */
const HARD_FETCH_CAP = 5;

/**
 * Fraction of the per-tool timeout budget allotted to each parallel fetch.
 * Fetches run concurrently (wall time ≈ one fetch), so a fraction below 1 leaves
 * headroom for the preceding provider search and the trailing extraction within
 * the single per-tool timeout the middleware enforces (see FEAT-WI-001 TASK-005).
 */
const FETCH_TIMEOUT_FRACTION = 0.6;

const WebSearchParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 400,
      description:
        'A focused search query distilled from the user intent (plain keywords or a question).',
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: HARD_FETCH_CAP,
        description:
          `Maximum number of top hits to fetch + extract inline (0–${HARD_FETCH_CAP}; also ` +
          'bounded by search.fetch_top). 0 returns titles, URLs, and snippets only and fetches ' +
          'nothing.',
      }),
    ),
  },
  { additionalProperties: false },
);

type WebSearchParamsType = Static<typeof WebSearchParams>;

/**
 * Build the `web_search` tool spec for one run.
 *
 * @param _services Reserved for symmetry with the other tool factories.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function webSearchSpec(_services: RunServices): ToolWrapperSpec<typeof WebSearchParams> {
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      'Search the public web and return the top results WITH their extracted page content and ' +
      'references — evidence in one call, not just links. With limit 0 it only discovers: ' +
      'titles, URLs, and snippets, with no page fetched. Refine the user’s intent into a ' +
      'focused search query before calling. Every fetched site is also recorded as a source ' +
      'for your published result automatically. Do NOT call it repeatedly for the same intent, ' +
      'and do NOT use it for authenticated, private, or logged-in data; use web_fetch only for ' +
      'a specific URL you already have.',
    parameters: WebSearchParams,
    sanitizationProfile: 'public',
    budgetMeter: true,
    evidenceGathering: true,
    run: (params: WebSearchParamsType, ctx): Promise<DomainResult> =>
      runWebSearch(params, ctx.services, ctx.signal),
  };
}

/** Every URL a search result shows is attested by this tool. */
const SEARCH_ORIGIN = { kind: 'tool', tool: 'web_search' } as const;

async function runWebSearch(
  params: WebSearchParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  const deps = services.domain.search;
  // `limit` caps fetched sites, bounded by the configured fetch_top and the hard
  // cap; the provider search breadth stays `resultCap` so the unfetched tail can
  // still be offered as "more results".
  const fetchTop = Math.min(params.limit ?? deps.fetchTop, deps.fetchTop, HARD_FETCH_CAP);

  // The run's one provider, behind its politeness gate and challenge breaker.
  const resolved = await deps.service.resolve();
  if (!resolved.isOk) {
    // A resolution failure is configuration (missing key, no usable provider),
    // never a transient outage: classified through the same table as a search
    // throw, so it is no longer reported as retryable.
    return mapSearchError(resolved.error, null);
  }
  const provider: SearchProvider = resolved.value;

  let hits: readonly SearchResult[];
  try {
    hits = await provider.search(params.query, { limit: deps.resultCap, signal });
  } catch (error) {
    // Every provider cause maps to its own stable code.
    return mapSearchError(error, provider.name);
  }

  if (params.limit === 0) return discover(params.query, provider.name, hits, services);

  const perFetchTimeoutMs = Math.max(
    1,
    Math.floor(services.budgets.perToolTimeoutMs * FETCH_TIMEOUT_FRACTION),
  );
  const top = hits.slice(0, fetchTop);
  const remaining = hits.slice(fetchTop);

  // Parallel reads with per-hit isolation: `readHit` never throws for a
  // per-site failure, and `Promise.all` keeps search-rank order.
  const reads = await Promise.all(
    top.map((hit) => readHit(hit, services, { perFetchTimeoutMs, signal })),
  );

  recordReadRanks(reads, remaining, services);

  return mapReads(params.query, provider.name, reads, remaining, services);
}

/**
 * `limit: 0`: report what the provider found and fetch nothing. Each URL is
 * attested exactly as `more_results` are, so the model may `web_fetch` one.
 */
function discover(
  query: string,
  provider: string,
  hits: readonly SearchResult[],
  services: RunServices,
): DomainResult {
  const results = hits.map((hit) => ({ url: hit.url, title: hit.title, snippet: hit.snippet }));
  for (const hit of hits) {
    services.urlProvenance.record(hit.url, SEARCH_ORIGIN);
    recordSearchResult(hit.url, services);
  }
  return {
    ok: true,
    model: {
      query,
      mode: 'discovery',
      results,
      note: renderAgentMessage('tool', 'WEB_SEARCH', 'discovery'),
    },
    diagnostic: { provider },
    details: { provider, mode: 'discovery', discovered: results.length },
  };
}

/** One top hit after the store answered it. */
type HitRead =
  /** This call fetched the page (or failed to). `memoized` replays an earlier failure. */
  | {
      readonly kind: 'processed';
      readonly processed: ProcessedSource;
      readonly record: DocumentRecord | null;
      readonly memoized: boolean;
    }
  /** The page was already read in this run; nothing was fetched. */
  | { readonly kind: 'already-read'; readonly record: DocumentRecord }
  /** The run's own URL policy refused the hit before the store was asked. */
  | { readonly kind: 'refused'; readonly processed: ProcessedSource }
  /** The run's own budget refused the read; reported once at the top level. */
  | { readonly kind: 'budget'; readonly url: string; readonly limit: BudgetLimitName };

/** What a failed hit load hands the store: the outcome and the gate decision behind it. */
interface HitFailure {
  readonly processed: ProcessedSource;
  readonly decision: AskEthicsDecision;
}

/**
 * Read one top hit: URL policy (no charge) → document store → (only on a
 * miss) ethics → navigation charge → fetch → extract.
 */
async function readHit(
  hit: SearchResult,
  services: RunServices,
  opts: { readonly perFetchTimeoutMs: number; readonly signal: AbortSignal },
): Promise<HitRead> {
  const allowed = services.urlPolicy.evaluate(hit.url);
  if (!allowed.isOk) {
    return {
      kind: 'refused',
      processed: {
        rank: hit.rank,
        doc: null,
        failure: sourceFailureOf(
          hit.url,
          'policy',
          `policy - url-policy: ${allowed.error.message}`,
        ),
        fetchMode: null,
      },
    };
  }

  // The gate's decision for this hit, read back to classify the outcome.
  const gated: { decision: AskEthicsDecision } = { decision: { ok: true } };
  const gate = perHitGate(services, allowed.value, gated);
  const read = await services.documents.read<ProcessedSource>(
    allowed.value.url,
    async (): Promise<LoadOutcome<ProcessedSource>> => {
      const fetchDeps = services.domain.fetch;
      const processed = await processSource(
        { ethicsGate: gate, fetcher: fetchDeps.fetcher, extractor: fetchDeps.extractor },
        hit,
        opts,
      );
      // A real network fetch happened whenever a fetch mode is known,
      // including a page that was fetched but could not be extracted.
      if (processed.fetchMode !== null) {
        services.runHealth.recordFetch(processed.doc?.finalUrl ?? hit.url, processed.fetchMode);
      }
      if (processed.doc !== null) {
        return {
          ok: true,
          value: processed,
          meta: {
            url: hit.url,
            finalUrl: processed.doc.finalUrl,
            title: processed.doc.title,
            fetchMode: processed.fetchMode ?? 'http',
            tool: 'web_search',
          },
        };
      }
      const failure = processed.failure ?? sourceFailureOf(hit.url, 'fetch', 'fetch failed');
      return {
        ok: false,
        terminal: isTerminalHitFailure(failure, processed, gated.decision),
        code: failure.stage,
        reason: failure.reason,
        failure: { processed, decision: gated.decision } satisfies HitFailure,
      };
    },
  );

  switch (read.kind) {
    case 'fetched':
      return { kind: 'processed', processed: read.value, record: read.record, memoized: false };
    case 'hit':
      return { kind: 'already-read', record: read.record };
    case 'failed': {
      // The payload of whichever load ran — this call's, or the concurrent
      // read this call joined — so its gate decision is the one that applied.
      const { processed, decision } = read.failure as HitFailure;
      if (processed.failure?.stage === 'budget') {
        return {
          kind: 'budget',
          url: hit.url,
          limit: !decision.ok && decision.reason === 'budget' ? decision.limit : 'navigations',
        };
      }
      return { kind: 'processed', processed, record: null, memoized: read.memoized };
    }
  }
}

/**
 * Whether a hit's failure cannot change within the run. Delegates to the one
 * core list ({@link isTerminalFetchFailure}); the stage only tells us which
 * cause to hand it, because `processSource` folds causes into stages.
 */
function isTerminalHitFailure(
  failure: SourceFailure,
  processed: ProcessedSource,
  decision: AskEthicsDecision,
): boolean {
  switch (failure.stage) {
    case 'extract':
      return true;
    case 'blocked':
      // An ethics refusal by robots or the blocklist; a rate limit can clear.
      return !decision.ok && (decision.reason === 'robots' || decision.reason === 'blocklist');
    case 'fetch':
      return isTerminalFetchFailure(processed.cause);
    case 'budget':
    case 'policy':
      return false;
  }
}

/**
 * The gate `processSource` runs for one hit, after the store missed: ethics
 * first, then the navigation charge for the URL policy already evaluated. A
 * spent navigation/host budget is stage `budget` and only an ethics refusal is
 * stage `blocked`, so the run's own limits can never read as the site refusing
 * it. Each decision is written to `gated` so the caller can classify it.
 */
function perHitGate(
  services: RunServices,
  allowed: AllowedUrl,
  gated: { decision: AskEthicsDecision },
): AskEthicsGate {
  const ethics = createAskEthicsAdapter(services.domain.fetch.ethics, {
    taskId: services.runId,
    runId: services.runId,
    stepId: 'web_search',
    action: 'fetch',
  });
  return {
    async checkUrl(url) {
      const ethical = await ethics.checkUrl(url);
      if (!ethical.ok) {
        gated.decision = ethical;
        return ethical;
      }
      const reserved = services.urlPolicy.reserve(allowed);
      if (!reserved.isOk) {
        const rejection = reserved.error;
        gated.decision =
          rejection.code === 'BUDGET_EXHAUSTED'
            ? {
                ok: false,
                reason: 'budget',
                limit: rejection.budgetLimit ?? 'navigations',
                detail: rejection.message,
              }
            : {
                ok: false,
                reason: 'policy',
                code: rejection.code,
                detail: `url-policy: ${rejection.message}`,
              };
        return gated.decision;
      }
      gated.decision = { ok: true };
      return gated.decision;
    },
  };
}

/** Record the provider's own observation of a hit (one positive signal). */
function recordSearchResult(url: string, services: RunServices): void {
  const domain = domainFromUrl(url);
  if (domain !== null) {
    safeRecordRankSignal(services.domain.rank, { domain, delta: 1, reason: 'search_result' });
  }
}

/**
 * Record every hit the provider returned once, plus a negative observation for
 * a failure this call actually observed. A page already read adds nothing (it
 * was observed when it was read), a replayed memo is not a new observation, and
 * a hit the run's own budget skipped still counts as a search result.
 */
function recordReadRanks(
  reads: readonly HitRead[],
  remaining: readonly SearchResult[],
  services: RunServices,
): void {
  for (const read of reads) {
    if (read.kind === 'already-read') continue;
    if (read.kind === 'budget') {
      // The provider did return it; only the run's own limit kept it unread,
      // which is never negative evidence about the domain.
      recordSearchResult(read.url, services);
      continue;
    }
    const { processed } = read;
    const url = processed.doc?.url ?? processed.failure?.url;
    if (url === undefined) continue;
    recordSearchResult(url, services);
    if (read.kind === 'processed' && read.memoized) continue;
    // Only site-caused failures are negative evidence about a domain; the
    // run's own budget and URL-policy refusals (null reason) are not.
    const reason =
      processed.failure === null ? null : rankReasonForFailureStage(processed.failure.stage);
    const domain = domainFromUrl(url);
    if (reason !== null && domain !== null) {
      safeRecordRankSignal(services.domain.rank, { domain, delta: -1, reason });
    }
  }
  for (const hit of remaining) recordSearchResult(hit.url, services);
}

/** Project the reads onto the model-visible, byte-bounded tool result. */
async function mapReads(
  query: string,
  provider: string,
  reads: readonly HitRead[],
  remaining: readonly SearchResult[],
  services: RunServices,
): Promise<DomainResult> {
  const threshold = services.domain.fetch.captureThresholdBytes;
  const sites: unknown[] = [];
  const failures: { url: string; stage: string; reason: string }[] = [];
  const skippedByLimit = new Map<BudgetLimitName, number>();
  let captureCount = 0;
  let alreadyRead = 0;

  for (const read of reads) {
    if (read.kind === 'budget') {
      // Reported once at the top level, never per site: the site did
      // nothing, and a per-site line read as the site refusing the run.
      skippedByLimit.set(read.limit, (skippedByLimit.get(read.limit) ?? 0) + 1);
      continue;
    }
    if (read.kind === 'already-read') {
      // No text, no evidence re-add: the content was returned when it was read.
      services.runHealth.recordCacheHit();
      alreadyRead += 1;
      sites.push({
        source_id: read.record.sourceId,
        url: read.record.url,
        title: read.record.title,
        already_read: true,
      });
      continue;
    }
    const { processed } = read;
    if (processed.doc !== null && read.kind === 'processed' && read.record !== null) {
      const { record } = read;
      const doc = processed.doc;
      const base = {
        source_id: record.sourceId,
        url: doc.url,
        title: doc.title,
        published_at: doc.publishedAt,
        excerpt: doc.excerpt ?? doc.text.slice(0, 1000),
      };
      // A search hit is an attested URL: the model may navigate to it later.
      services.urlProvenance.record(doc.url, SEARCH_ORIGIN);
      // Every fetched site becomes ledger evidence: result_publish attaches
      // these as the Brief's sources, so the model never re-types URLs.
      services.evidence.add({
        url: doc.url,
        finalUrl: null,
        title: doc.title,
        excerpt: base.excerpt,
        fetchedAt: services.nowIso(),
        publishedAt: doc.publishedAt,
        tool: 'web_search',
        sourceId: record.sourceId,
      });
      const textBytes = Buffer.byteLength(doc.text, 'utf8');
      if (textBytes > threshold) {
        const captureRef = await writeCapture(services.runDir, doc.text);
        services.documents.attachCapture(record.sourceId, captureRef);
        captureCount += 1;
        sites.push({ ...base, capture_ref: captureRef });
      } else {
        sites.push({ ...base, text: doc.text });
      }
      continue;
    }
    const failure = processed.failure;
    if (failure === null) continue;
    if (read.kind === 'processed' && read.memoized) {
      services.runHealth.recordMemoHit();
    } else {
      services.runHealth.recordSourceFailure({
        tool: 'web_search',
        host: failure.host,
        stage: failure.stage,
        reason: failure.reason,
      });
    }
    failures.push({ url: failure.url, stage: failure.stage, reason: failure.reason });
  }

  for (const [limit, skipped] of skippedByLimit) {
    services.runHealth.recordBudgetExhaustion(limit, 'web_search', skipped);
  }
  const budget = budgetReport(skippedByLimit);

  const moreResults = remaining.map((hit) => ({
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
  }));
  // The unfetched tail is shown to the model as "more results", so those URLs
  // are equally attested — the model is invited to follow them.
  for (const hit of moreResults) services.urlProvenance.record(hit.url, SEARCH_ORIGIN);

  return {
    ok: true,
    model: {
      query,
      sites,
      more_results: moreResults,
      failures,
      ...(budget === null ? {} : { budget }),
      // Small local models cannot reliably round-trip URLs into a typed
      // payload (observed: sources: [{url: "N/A"}], and a post-nudge re-search
      // that changed the answer). Sources attach from the run's evidence
      // ledger, so the note steers the model straight to publishing prose.
      note:
        'These sites are recorded as your sources automatically, each under its source_id. ' +
        'When you are done, call result_publish with your title and overview — do not search ' +
        'again for the same topic and do not re-type URLs.',
    },
    diagnostic: { provider },
    details: {
      provider,
      fetched: sites.length - alreadyRead,
      already_read: alreadyRead,
      failed: failures.length,
      ...(budget === null
        ? {}
        : { budget_limit: budget.exhausted, skipped_reads: budget.skipped_reads }),
      more_results: moreResults.length,
      captures: captureCount,
    },
  };
}

/** A per-site failure with a best-effort host (mirrors core `sourceFailure`). */
function sourceFailureOf(
  url: string,
  stage: SourceFailure['stage'],
  reason: string,
): SourceFailure {
  return { url, host: domainFromUrl(url) ?? url, stage, reason };
}

/**
 * The single top-level report of reads the run's own budget skipped, or null
 * when none were. With more than one limit spent, the first one hit is named
 * and the skipped reads are summed.
 */
function budgetReport(skippedByLimit: ReadonlyMap<BudgetLimitName, number>): {
  readonly exhausted: BudgetLimitName;
  readonly skipped_reads: number;
  readonly message: string;
} | null {
  const first = skippedByLimit.keys().next();
  if (first.done === true) return null;
  const limit = first.value;
  const skipped = [...skippedByLimit.values()].reduce((sum, count) => sum + count, 0);
  return {
    exhausted: limit,
    skipped_reads: skipped,
    message: renderAgentMessage('tool', 'BUDGET_EXHAUSTED', 'search-reads-skipped', {
      limit,
      skipped,
    }),
  };
}
