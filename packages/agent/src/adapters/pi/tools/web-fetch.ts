/**
 * `web_fetch` tool spec (FEAT-024 TASK-005, plan_agentic.md §5/§8.13).
 *
 * Wraps the existing `@yantra/core` fetch + readability extraction path with the
 * mandatory pre-fetch controls: the outbound URL policy (length cap, https,
 * credential-shape scan, host budget), the ethics gate (robots/blocklist/rate
 * limit), a content-type allowlist, and a streamed size limit. The extracted
 * text is sanitized by the middleware before return; large content is stored as
 * a run capture and referenced rather than dumped inline.
 *
 * Every read goes through the run document store (FEAT-050): a page already
 * read returns `already_read` with its evidence ID and no fetch, a URL whose
 * earlier read failed terminally returns the original code without a fetch,
 * and a navigation is charged only when a real network fetch happens.
 */

import {
  EthicsRefusedError,
  FetchError,
  UnreadableContentError,
  domainFromUrl,
  isTerminalFetchFailure,
  safeRecordRankSignal,
  type DocumentRecord,
  type DomainRankReason,
  type FetchedDoc,
  type LoadOutcome,
  type PageAnalysis,
  type PageExtraction,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import { renderAgentMessage } from '../../../runtime/messages.js';
import {
  asDetailsRecord,
  type DomainFailure,
  type DomainResult,
  type ToolWrapperSpec,
} from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import type { AllowedUrl, UrlPolicyRejection } from '../../../runtime/url-policy.js';
import { provenanceDetails } from '../../../runtime/url-provenance.js';

import { mapBrowserStartupError } from './browser-startup-errors.js';
import { fullViewBudget, projectPage, recordDiscovered } from './page-payload.js';
import { recordProvenanceRefusal } from './provenance-refusals.js';

/**
 * The closed `web_fetch` failure-cause vocabulary (operator-only diagnostics).
 * Parametric entries: `ethics-refused:<reason>` (robots | blocklist |
 * rate-limit), `budget:<limit>` (navigations | hosts), and `url-<code>` for
 * the outbound URL policy's stable codes.
 */
export const WEB_FETCH_FAILURE_CAUSES = Object.freeze([
  'unattested-url',
  'url-policy:<code>',
  'budget:<limit>',
  'ethics-refused:<reason>',
  'timeout',
  'too-large',
  'http-4xx',
  'http-5xx',
  'network',
  'browser-startup',
  'content-type-refused',
  'extraction-empty',
  'already-attempted',
  'challenge',
] as const);

const WebFetchParams = Type.Object(
  {
    url: Type.String({
      minLength: 1,
      maxLength: 2048,
      description: 'The absolute https URL of a public page to fetch and extract.',
    }),
  },
  { additionalProperties: false },
);

type WebFetchParamsType = Static<typeof WebFetchParams>;

/**
 * Build the `web_fetch` tool spec for one run.
 *
 * @param _services Reserved for symmetry with the other tool factories.
 * @returns The provider-neutral tool spec consumed by `wrapTool`.
 */
export function webFetchSpec(_services: RunServices): ToolWrapperSpec<typeof WebFetchParams> {
  return {
    name: 'web_fetch',
    label: 'Web Fetch',
    description:
      'Fetch ONE specific public URL you already have (from search results, the goal, or a ' +
      "link in links[] or records[] of a page you already read) and return the page's shape " +
      'and content, plus the links it offers. A URL no result attested is refused. ' +
      'Do NOT use it to explore a topic — web_search already returns page content for a query. ' +
      'Do NOT use it to bypass a paywall/login, to reach a blocked or non-public host, or to ' +
      'download non-text content (PDFs, images, binaries). Every fetched page is recorded as ' +
      'a source for your published result automatically.',
    parameters: WebFetchParams,
    sanitizationProfile: 'public',
    budgetMeter: true,
    evidenceGathering: true,
    run: async (params: WebFetchParamsType, ctx): Promise<DomainResult> => {
      // Provenance gates every fetch (FEAT-051, closes TODO 208): a URL no
      // search result, page read, or goal attested is refused before policy,
      // the store, or any budget is touched — exactly as browser_navigate does.
      const explanation = ctx.services.urlProvenance.explain(params.url);
      if (explanation === null) return unattested(params.url, ctx.services);
      const result = await runWebFetch(params, ctx.services, ctx.signal);
      return withProvenance(result, provenanceDetails(explanation));
    },
  };
}

async function runWebFetch(
  params: WebFetchParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  // 1. Outbound URL policy (length, https, credential shapes, allowed hosts),
  // charging nothing yet: a read the document store answers from memory must
  // pass policy but must not spend a navigation. Policy still runs before the
  // store, so a refused URL never reaches a cached answer.
  const allowed = services.urlPolicy.evaluate(params.url);
  if (!allowed.isOk) {
    return policyFailure(allowed.error, params.url, services);
  }
  const host = allowed.value.host;

  // 2. The run document store: one network fetch per page per run.
  const read = await services.documents.read<FetchedPage>(allowed.value.url, () =>
    loadPage(allowed.value, services, signal),
  );

  switch (read.kind) {
    case 'hit': {
      services.runHealth.recordCacheHit();
      const { record } = read;
      // A page web_search showed only as a summary: the full view is one store
      // read away — no network load, no navigation charged, no evidence re-add.
      if (record.page !== null && record.page.delivered === 'summary') {
        return storeServedFullView(record, record.page, services, host);
      }
      return {
        ok: true,
        model: {
          already_read: record.sourceId,
          source_id: record.sourceId,
          url: record.url,
          title: record.title,
          ...(record.captureRef === null ? {} : { capture_ref: record.captureRef }),
          note: renderAgentMessage('tool', 'WEB_READ', 'already-read', {
            source_id: record.sourceId,
          }),
        },
        details: { already_read: record.sourceId },
        diagnostic: { host },
      };
    }
    case 'failed': {
      const original = read.failure as DomainFailure;
      if (!read.memoized) return original;
      // The memo answered: the same code, told plainly that nothing was
      // fetched this time, so the agent stops asking for it.
      services.runHealth.recordMemoHit();
      return withHost(
        {
          ok: false,
          errorCode: original.errorCode,
          message: renderAgentMessage('tool', 'WEB_READ', 'already-attempted', {
            code: original.errorCode,
          }),
          retryable: false,
          details: { ...asDetailsRecord(original.details), already_attempted: true },
        },
        'already-attempted',
        host,
      );
    }
    case 'fetched':
      return publishPage(read.record, read.value, services, host);
  }
}

/** What a successful `web_fetch` load hands back to the store's caller. */
interface FetchedPage {
  readonly doc: FetchedDoc;
  readonly extraction: PageExtraction;
}

/**
 * The network half of `web_fetch`, run only when the store has no answer:
 * ethics → navigation charge → fetch → content-type check → extraction.
 * Every failure keeps today's stable code; whether the store may remember it
 * comes from {@link isTerminalFetchFailure}, never from a list kept here.
 */
async function loadPage(
  allowed: AllowedUrl,
  services: RunServices,
  signal: AbortSignal,
): Promise<LoadOutcome<FetchedPage>> {
  const deps = services.domain.fetch;
  const host = allowed.host;

  // Ethics gate (robots/blocklist/rate limit) — no evasion path exists.
  try {
    await deps.ethics.check(allowed.url, 'fetch', {
      taskId: services.runId,
      runId: services.runId,
      stepId: 'web_fetch',
    });
  } catch (error) {
    if (error instanceof EthicsRefusedError) {
      recordFailure(services, allowed.url, 'blocked');
      const source =
        error.ethicsContext.source === 'rate_limit' ? 'rate-limit' : error.ethicsContext.source;
      return failed(
        error,
        withHost(
          {
            ok: false,
            errorCode: 'ETHICS_BLOCKED',
            message: `Fetch refused for ${host}: ${error.ethicsContext.reason}.`,
            retryable: false,
            details: { source: error.ethicsContext.source, host },
          },
          `ethics-refused:${source}`,
          host,
        ),
      );
    }
    throw error;
  }

  // Charge the navigation only now, when a real fetch is about to happen.
  const reserved = services.urlPolicy.reserve(allowed);
  if (!reserved.isOk) {
    // The run's own limit, not a fact about the page: never memoized.
    return failed(null, policyFailure(reserved.error, allowed.url, services));
  }

  // Fetch with timeout + streamed size limit.
  let doc: FetchedDoc;
  try {
    doc = await deps.fetcher.fetch(allowed.url, {
      timeoutMs: services.budgets.perToolTimeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof FetchError && error.context.kind === 'challenge') {
      // The site's bot detection refused the standard browser too (policy b):
      // terminal for this URL, never extracted, and the run hands off if it
      // publishes nothing. A `blocked` rank signal is correct: the site
      // refused us. Memoized (terminal), so a re-call costs no fetch.
      recordFailure(services, allowed.url, 'blocked');
      return failed(error, siteChallenge(host, error.context.tier ?? 'browser'));
    }
    if (error instanceof FetchError) {
      recordFailure(services, allowed.url, 'fetch_failed');
      const mapped = mapFetchError(error);
      return failed(error, withHost({ ok: false, ...mapped.failure }, mapped.cause, host));
    }
    // The hybrid fetcher escalates to a headless browser for script-rendered
    // pages, so a browser that will not start reaches `web_fetch` too — as a
    // typed core error rather than a `FetchError`. Without this the agent was
    // told a generic tool fault and kept retrying a fetch no retry could fix.
    // Not a rank signal: the site did nothing wrong.
    const startup = mapBrowserStartupError(error);
    if (startup !== null) return failed(error, withHost(startup, 'browser-startup', host));
    throw error;
  }
  // A page came back over the network: count it whether or not it can be read.
  services.runHealth.recordFetch(doc.finalUrl, doc.fetchMode);

  // Content-type allowlist.
  const contentType = (doc.contentType ?? '').toLowerCase();
  if (!deps.allowedContentTypes.some((prefix) => contentType.includes(prefix))) {
    recordFailure(services, allowed.url, 'extract_failed');
    return failed(
      new UnreadableContentError('content-type-refused'),
      withHost(
        {
          ok: false,
          errorCode: 'CONTENT_TYPE_REFUSED',
          message: `Refusing non-text content type "${doc.contentType ?? 'unknown'}".`,
          retryable: false,
        },
        'content-type-refused',
        host,
      ),
    );
  }

  // Shape-aware extraction on one parse (FEAT-051). Only a page with no
  // article and no page parts at all — no records, tables, fields, structured
  // data, or followable links — is empty; the message says what was looked
  // for, and the failure stays terminal.
  const extraction = await deps.extractor.extractPage(doc);
  if (extraction.page.shape === null) {
    recordFailure(services, allowed.url, 'extract_failed');
    return failed(
      new UnreadableContentError('extraction-empty'),
      withHost(
        {
          ok: false,
          errorCode: 'EXTRACTION_EMPTY',
          message: renderAgentMessage('tool', 'EXTRACTION_EMPTY', 'nothing-readable', {
            looked_for: lookedFor(extraction.page),
          }),
          retryable: false,
          details: { final_url: doc.finalUrl, fetch_mode: doc.fetchMode },
        },
        'extraction-empty',
        host,
      ),
    );
  }

  return {
    ok: true,
    value: { doc, extraction },
    meta: {
      url: allowed.url,
      finalUrl: doc.finalUrl,
      title: extraction.article?.title ?? null,
      fetchMode: doc.fetchMode,
      tool: 'web_fetch',
    },
  };
}

/** Project a page this call fetched onto the model-visible result. */
async function publishPage(
  record: DocumentRecord,
  page: FetchedPage,
  services: RunServices,
  host: string,
): Promise<DomainResult> {
  const { doc, extraction } = page;
  const { article } = extraction;

  // A successfully fetched page is an attested URL, so the model may navigate
  // to it later. Recorded only on success — a URL that could not be fetched and
  // read attests nothing, which keeps a failed guess from earning navigation.
  services.urlProvenance.record(doc.url, FETCH_ORIGIN);
  services.urlProvenance.record(doc.finalUrl, FETCH_ORIGIN);

  const stored = services.documents.attachPage(record.sourceId, extraction.page, {
    delivered: 'full',
    article: article === null ? null : { byline: article.byline, publishedAt: article.publishedAt },
  });
  if (stored === null) throw new Error(`document store lost ${record.sourceId}`);
  const projection = await projectPage(
    { sourceId: record.sourceId, url: doc.finalUrl, title: article?.title ?? null, page: stored },
    'full',
    fullViewBudget(services.budgets.maxBytesPerResult),
    services,
  );
  // Every URL the view shows becomes navigable, attributed to this source (G3).
  recordDiscovered(services, record.sourceId, projection.model);
  if (projection.textCaptureRef !== null) {
    services.documents.attachCapture(record.sourceId, projection.textCaptureRef);
  }

  // The fetched page becomes ledger evidence: result_publish attaches these
  // as the Brief's sources, so the model never re-types URLs.
  services.evidence.add({
    url: doc.finalUrl,
    finalUrl: doc.finalUrl === doc.url ? null : doc.finalUrl,
    title: article?.title ?? null,
    excerpt: evidenceExcerpt(extraction),
    fetchedAt: services.nowIso(),
    publishedAt: article?.publishedAt ?? null,
    tool: 'web_fetch',
    sourceId: record.sourceId,
  });

  return {
    ok: true,
    model: projection.model,
    details: {
      bytes: Buffer.byteLength(extraction.page.readableText, 'utf8'),
      final_url: doc.finalUrl,
      source_id: record.sourceId,
      shape: extraction.page.shape,
      ...captureDetails(projection),
    },
    diagnostic: { host, fetch_mode: doc.fetchMode },
  };
}

/**
 * The full view of a page `web_search` showed only as a summary, served from
 * the run's store: no network load, no navigation charged, no evidence re-add,
 * and no rank signal. Marked delivered, so a later read is `already_read`.
 */
async function storeServedFullView(
  record: DocumentRecord,
  page: NonNullable<DocumentRecord['page']>,
  services: RunServices,
  host: string,
): Promise<DomainResult> {
  const projection = await projectPage(
    { sourceId: record.sourceId, url: record.finalUrl ?? record.url, title: record.title, page },
    'full',
    fullViewBudget(services.budgets.maxBytesPerResult),
    services,
  );
  recordDiscovered(services, record.sourceId, projection.model);
  services.documents.markDelivered(record.sourceId, 'full');
  return {
    ok: true,
    model: { ...projection.model, from_store: true },
    details: {
      source_id: record.sourceId,
      from_store: true,
      shape: page.analysis.shape,
      ...captureDetails(projection),
    },
    diagnostic: { host },
  };
}

/** Characters of page content offered as the ledger excerpt (the ledger bounds it further). */
const EVIDENCE_EXCERPT_CHARS = 1_000;

/**
 * The ledger excerpt for a page, by shape: an article's own excerpt as before;
 * a collection's first three records; a detail page's first fields; a table
 * page's first table; an index page's readable text. Shared by every tool
 * that reads a page through the analyzer.
 *
 * @param extraction - The page's article and analysis.
 */
export function evidenceExcerpt(extraction: PageExtraction): string {
  const { article, page } = extraction;
  let excerpt: string;
  switch (page.shape) {
    case 'collection':
      excerpt =
        page.records.length > 0
          ? page.records
              .slice(0, 3)
              .map((entry) => [entry.title ?? '', ...entry.segments].filter(Boolean).join(' · '))
              .join('\n')
          : page.readableText;
      break;
    case 'detail':
      excerpt =
        page.fields.length > 0
          ? page.fields.map((field) => `${field.label}: ${field.value}`).join('\n')
          : page.readableText;
      break;
    case 'table': {
      const [first] = page.tables;
      excerpt =
        first === undefined
          ? page.readableText
          : [first.headers, ...first.rows].map((row) => row.join(' | ')).join('\n');
      break;
    }
    case 'article':
      excerpt = article?.excerpt ?? page.readableText;
      break;
    default:
      excerpt = page.readableText;
  }
  return excerpt.slice(0, EVIDENCE_EXCERPT_CHARS);
}

/** The phrase listing what an empty read looked for. */
function lookedFor(page: PageAnalysis): string {
  return page.coverage.not_found.map((phrase) => phrase.replace(/^no /u, '')).join(', ');
}

/** Capture references a projection wrote, for the audit. */
function captureDetails(projection: {
  readonly textCaptureRef: string | null;
  readonly analysisCaptureRef: string | null;
}): Record<string, string> {
  return {
    ...(projection.textCaptureRef === null ? {} : { capture_ref: projection.textCaptureRef }),
    ...(projection.analysisCaptureRef === null
      ? {}
      : { analysis_capture_ref: projection.analysisCaptureRef }),
  };
}

/** URLs a fetched page itself attests: its requested and final URL. */
const FETCH_ORIGIN = { kind: 'tool', tool: 'web_fetch' } as const;

/**
 * A URL no evidence attested, refused before anything is spent. The repeat
 * counter is shared with `browser_navigate`, so the "repeated" wording follows
 * the URL across both tools.
 */
function unattested(url: string, services: RunServices): DomainFailure {
  const count = recordProvenanceRefusal(services, url);
  return withHost(
    {
      ok: false,
      errorCode: 'URL_NOT_FROM_EVIDENCE',
      message: renderAgentMessage('tool', 'URL_NOT_FROM_EVIDENCE', 'unattested-fetch-url', {
        repeated: count >= 2,
      }),
      retryable: true,
      details: { provenance: provenanceDetails(null) },
    },
    'unattested-url',
    domainFromUrl(url),
  );
}

/** Attach the audit-only provenance detail to a result, success or failure. */
function withProvenance(
  result: DomainResult,
  provenance: Readonly<Record<string, string>>,
): DomainResult {
  return { ...result, details: { ...asDetailsRecord(result.details), provenance } };
}

/**
 * A human-verification page as a stable tool failure. `handoff: true` makes a
 * run that publishes nothing end as a handoff to the user, not a failure.
 */
function siteChallenge(host: string, tier: 'http' | 'browser'): DomainFailure {
  return withHost(
    {
      ok: false,
      errorCode: 'SITE_CHALLENGE',
      message: renderAgentMessage('tool', 'SITE_CHALLENGE', 'challenge', { host }),
      retryable: false,
      details: { host, tier, handoff: true },
    },
    'challenge',
    host,
  );
}

/** A URL-policy refusal (including a spent budget) as a stable tool failure. */
function policyFailure(
  rejection: UrlPolicyRejection,
  url: string,
  services: RunServices,
): DomainFailure {
  const budgetLimit = rejection.code === 'BUDGET_EXHAUSTED' ? rejection.budgetLimit : undefined;
  if (budgetLimit !== undefined) {
    // The run's own limit refused this read, not the site.
    services.runHealth.recordBudgetExhaustion(budgetLimit, 'web_fetch', 1);
  }
  return withHost(
    {
      ok: false,
      errorCode: rejection.code,
      message: rejection.message,
      retryable: rejection.retryable,
    },
    budgetLimit !== undefined
      ? `budget:${budgetLimit}`
      : `url-policy:${rejection.code.toLowerCase().replaceAll('_', '-')}`,
    domainFromUrl(url),
  );
}

/** A load failure, memoizable exactly when its cause is terminal. */
function failed(cause: unknown, failure: DomainFailure): LoadOutcome<FetchedPage> {
  return {
    ok: false,
    terminal: isTerminalFetchFailure(cause),
    code: failure.errorCode,
    reason: failure.diagnostic?.cause ?? failure.errorCode,
    failure,
  };
}

/**
 * Attach the operator-only cause and hostname to a failure. The cause comes
 * from {@link WEB_FETCH_FAILURE_CAUSES}; the host is a bare hostname.
 */
function withHost(failure: DomainFailure, cause: string, host: string | null): DomainFailure {
  return { ...failure, diagnostic: { cause, ...(host === null ? {} : { host }) } };
}

function recordFailure(services: RunServices, url: string, reason: DomainRankReason): void {
  const domain = domainFromUrl(url);
  if (domain !== null) {
    safeRecordRankSignal(services.domain.rank, { domain, delta: -1, reason });
  }
}

/** Map a core FetchError kind to a stable tool error plus its closed cause. */
function mapFetchError(error: FetchError): {
  readonly failure: {
    readonly errorCode: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly cause: string;
} {
  switch (error.context.kind) {
    case 'timeout':
      return {
        failure: { errorCode: 'FETCH_TIMEOUT', message: 'The fetch timed out.', retryable: true },
        cause: 'timeout',
      };
    case 'too-large':
      return {
        failure: {
          errorCode: 'CONTENT_TOO_LARGE',
          message: 'The page body exceeded the size limit and was aborted.',
          retryable: false,
        },
        cause: 'too-large',
      };
    case 'http-status': {
      const status = error.context.statusCode;
      return {
        failure: {
          errorCode: 'FETCH_HTTP_ERROR',
          message: `The server returned HTTP ${status ?? '4xx/5xx'}.`,
          retryable: true,
        },
        cause: status !== undefined && status >= 500 ? 'http-5xx' : 'http-4xx',
      };
    }
    default:
      return {
        failure: {
          errorCode: 'FETCH_FAILED',
          message: 'A network failure occurred while fetching the page.',
          retryable: true,
        },
        cause: 'network',
      };
  }
}
