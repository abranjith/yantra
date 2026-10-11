/**
 * `web_search` tool spec (FEAT-WI-001) — combined search-that-fetches.
 *
 * One call returns *evidence, not pointers*: the tool runs the provider search,
 * then fetches and extracts the top-N hits through the **same** `@yantra/core`
 * per-source path the deterministic pipeline uses ({@link webResearch} over
 * {@link processSource}), returning strongly-typed per-site content with stable
 * reference numbers. This collapses the search → fetch → fetch → fetch chain
 * that small local models handle poorly into a single tool round trip.
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
  rankReasonForFailureStage,
  safeRecordRankSignal,
  webResearch,
  type AskEthicsGate,
  type BudgetLimitName,
  type ProcessedSource,
  type SearchResult,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

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
        minimum: 1,
        maximum: HARD_FETCH_CAP,
        description: `Maximum number of top hits to fetch + extract inline (1–${HARD_FETCH_CAP}; also bounded by search.fetch_top).`,
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
      'references — evidence in one call, not just links. Refine the user’s intent into a ' +
      'focused search query before calling. Every fetched site is also recorded as a source ' +
      'for your published result automatically. Do NOT call it repeatedly for the same intent, ' +
      'and do NOT use it for authenticated, private, or logged-in data; use web_fetch only for ' +
      'a specific URL you already have.',
    parameters: WebSearchParams,
    sanitizationProfile: 'public',
    evidenceGathering: true,
    run: (params: WebSearchParamsType, ctx): Promise<DomainResult> =>
      runWebSearch(params, ctx.services, ctx.signal),
  };
}

async function runWebSearch(
  params: WebSearchParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  const deps = services.domain.search;
  const fetchDeps = services.domain.fetch;
  // `limit` caps fetched sites, bounded by the configured fetch_top and the hard
  // cap; the provider search breadth stays `resultCap` so the unfetched tail can
  // still be offered as "more results".
  const fetchTop = Math.min(params.limit ?? deps.fetchTop, deps.fetchTop, HARD_FETCH_CAP);

  const resolved = await deps.resolveProvider();
  if (!resolved.isOk) {
    // A resolution failure is configuration (missing key, no usable provider),
    // never a transient outage: classified through the same table as a search
    // throw, so it is no longer reported as retryable.
    return mapSearchError(resolved.error, null);
  }

  const perFetchTimeoutMs = Math.max(
    1,
    Math.floor(services.budgets.perToolTimeoutMs * FETCH_TIMEOUT_FRACTION),
  );

  // Which hits the run's own budget refused, and which limit refused each:
  // filled by the gate, read once when the outcome is projected.
  const budgetRefusals = new Map<string, BudgetLimitName>();
  let outcome;
  try {
    outcome = await webResearch(
      {
        provider: resolved.value,
        ethicsGate: buildPerUrlGate(services, budgetRefusals),
        fetcher: fetchDeps.fetcher,
        extractor: fetchDeps.extractor,
      },
      params.query,
      { fetchTop, resultCap: deps.resultCap, perFetchTimeoutMs, signal },
    );
  } catch (error) {
    // Only the provider search throws here (per-source fetch/extract failures
    // are carried on `processed`). Every cause maps to its own stable code.
    return mapSearchError(error, resolved.value.name);
  }

  recordOutcomeRanks(outcome, services);

  return mapOutcome(params.query, resolved.value.name, outcome, services, budgetRefusals);
}

/** Record every provider hit once, plus a negative observation for failures. */
function recordOutcomeRanks(outcome: WebResearchOutcomeLike, services: RunServices): void {
  for (const item of outcome.processed) {
    const url = item.doc?.url ?? item.failure?.url;
    if (url === undefined) continue;
    const domain = domainFromUrl(url);
    if (domain === null) continue;
    safeRecordRankSignal(services.domain.rank, {
      domain,
      delta: 1,
      reason: 'search_result',
    });
    // Only site-caused failures are negative evidence about a domain; the
    // run's own budget and URL-policy refusals (null reason) are not.
    const reason = item.failure === null ? null : rankReasonForFailureStage(item.failure.stage);
    if (reason !== null) {
      safeRecordRankSignal(services.domain.rank, { domain, delta: -1, reason });
    }
  }

  for (const hit of outcome.remaining) {
    const domain = domainFromUrl(hit.url);
    if (domain !== null) {
      safeRecordRankSignal(services.domain.rank, {
        domain,
        delta: 1,
        reason: 'search_result',
      });
    }
  }
}

/**
 * A per-URL gate that runs the outbound URL policy *then* the ethics gate for
 * every fetched hit, so no refusal aborts the whole batch. The three outcomes
 * stay distinct inside {@link processSource}: a spent navigation/host budget
 * is stage `budget`, any other URL-policy refusal is stage `policy` (both the
 * run's own limits), and only an ethics refusal is stage `blocked`.
 *
 * @param budgetRefusals Filled with each budget-refused URL and its limit.
 */
function buildPerUrlGate(
  services: RunServices,
  budgetRefusals: Map<string, BudgetLimitName>,
): AskEthicsGate {
  const ethics = createAskEthicsAdapter(services.domain.fetch.ethics, {
    taskId: services.runId,
    runId: services.runId,
    stepId: 'web_search',
    action: 'fetch',
  });
  return {
    async checkUrl(url) {
      const allowed = services.urlPolicy.check(url);
      if (!allowed.isOk) {
        const rejection = allowed.error;
        if (rejection.code === 'BUDGET_EXHAUSTED') {
          const limit = rejection.budgetLimit ?? 'navigations';
          budgetRefusals.set(url, limit);
          return { ok: false, reason: 'budget', limit, detail: rejection.message };
        }
        return {
          ok: false,
          reason: 'policy',
          code: rejection.code,
          detail: `url-policy: ${rejection.message}`,
        };
      }
      return ethics.checkUrl(allowed.value.url);
    },
  };
}

interface WebResearchOutcomeLike {
  readonly processed: readonly ProcessedSource[];
  readonly remaining: readonly SearchResult[];
}

/** Project the core outcome onto the model-visible, byte-bounded tool result. */
async function mapOutcome(
  query: string,
  provider: string,
  outcome: WebResearchOutcomeLike,
  services: RunServices,
  budgetRefusals: ReadonlyMap<string, BudgetLimitName>,
): Promise<DomainResult> {
  const threshold = services.domain.fetch.captureThresholdBytes;
  const sites: unknown[] = [];
  const failures: { url: string; stage: string; reason: string }[] = [];
  const skippedByLimit = new Map<BudgetLimitName, number>();
  let captureCount = 0;
  let n = 0;

  for (const item of outcome.processed) {
    // A real network fetch happened whenever a fetch mode is known, including
    // a page that was fetched but could not be extracted.
    const fetchedUrl = item.doc?.url ?? item.failure?.url;
    if (item.fetchMode !== null && fetchedUrl !== undefined) {
      services.runHealth.recordFetch(fetchedUrl, item.fetchMode);
    }
    if (item.doc) {
      n += 1;
      const doc = item.doc;
      const base = {
        n,
        url: doc.url,
        title: doc.title,
        published_at: doc.publishedAt,
        excerpt: doc.excerpt ?? doc.text.slice(0, 1000),
      };
      // A search hit is an attested URL: the model may navigate to it later.
      services.urlProvenance.record(doc.url);
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
      });
      const textBytes = Buffer.byteLength(doc.text, 'utf8');
      if (textBytes > threshold) {
        const captureRef = await writeCapture(services.runDir, doc.text);
        captureCount += 1;
        sites.push({ ...base, capture_ref: captureRef });
      } else {
        sites.push({ ...base, text: doc.text });
      }
    } else if (item.failure) {
      if (item.failure.stage === 'budget') {
        // Reported once at the top level, never per site: the site did
        // nothing, and a per-site line read as the site refusing the run.
        const limit = budgetRefusals.get(item.failure.url) ?? 'navigations';
        skippedByLimit.set(limit, (skippedByLimit.get(limit) ?? 0) + 1);
        continue;
      }
      services.runHealth.recordSourceFailure({
        tool: 'web_search',
        host: item.failure.host,
        stage: item.failure.stage,
        reason: item.failure.reason,
      });
      failures.push({
        url: item.failure.url,
        stage: item.failure.stage,
        reason: item.failure.reason,
      });
    }
  }

  for (const [limit, skipped] of skippedByLimit) {
    services.runHealth.recordBudgetExhaustion(limit, 'web_search', skipped);
  }
  const budget = budgetReport(skippedByLimit);

  const moreResults = outcome.remaining.map((hit) => ({
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
  }));
  // The unfetched tail is shown to the model as "more results", so those URLs
  // are equally attested — the model is invited to follow them.
  for (const hit of moreResults) services.urlProvenance.record(hit.url);

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
      // that changed the answer). Sources now attach from the run's evidence
      // ledger, so the note steers the model straight to publishing prose.
      note:
        'These sites are recorded as your sources automatically. When you are done, call ' +
        'result_publish with your title and overview — do not search again for the same topic ' +
        'and do not re-type URLs.',
    },
    diagnostic: { provider },
    details: {
      provider,
      fetched: sites.length,
      failed: failures.length,
      ...(budget === null
        ? {}
        : { budget_limit: budget.exhausted, skipped_reads: budget.skipped_reads }),
      more_results: moreResults.length,
      captures: captureCount,
    },
  };
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
