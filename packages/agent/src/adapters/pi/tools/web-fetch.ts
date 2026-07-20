/**
 * `web_fetch` tool spec (FEAT-024 TASK-005, plan_agentic.md §5/§8.13).
 *
 * Wraps the existing `@yantra/core` fetch + readability extraction path with the
 * mandatory pre-fetch controls: the outbound URL policy (length cap, https,
 * credential-shape scan, host budget), the ethics gate (robots/blocklist/rate
 * limit), a content-type allowlist, and a streamed size limit. The extracted
 * text is sanitized by the middleware before return; large content is stored as
 * a run capture and referenced rather than dumped inline.
 */

import {
  EthicsRefusedError,
  FetchError,
  domainFromUrl,
  safeRecordRankSignal,
  type DomainRankReason,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { writeCapture } from './capture.js';

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
      'Fetch ONE specific public URL you already have (a direct link, or a link discovered ' +
      'inside previously fetched content) and return its readable article text (title + body). ' +
      'Do NOT use it to explore a topic — web_search already returns page content for a query. ' +
      'Do NOT use it to bypass a paywall/login, to reach a blocked or non-public host, or to ' +
      'download non-text content (PDFs, images, binaries). Every fetched page is recorded as ' +
      'a source for your published result automatically.',
    parameters: WebFetchParams,
    sanitizationProfile: 'public',
    evidenceGathering: true,
    run: (params: WebFetchParamsType, ctx): Promise<DomainResult> =>
      runWebFetch(params, ctx.services, ctx.signal),
  };
}

async function runWebFetch(
  params: WebFetchParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  const deps = services.domain.fetch;

  // 1. Outbound URL policy (length, https, credential shapes, host budget).
  const allowed = services.urlPolicy.check(params.url);
  if (!allowed.isOk) {
    return {
      ok: false,
      errorCode: allowed.error.code,
      message: allowed.error.message,
      retryable: allowed.error.retryable,
    };
  }

  // 2. Ethics gate (robots/blocklist/rate limit) — no evasion path exists.
  try {
    await deps.ethics.check(allowed.value.url, 'fetch', {
      taskId: services.runId,
      runId: services.runId,
      stepId: 'web_fetch',
    });
  } catch (error) {
    if (error instanceof EthicsRefusedError) {
      recordFailure(services, allowed.value.url, 'blocked');
      return {
        ok: false,
        errorCode: 'ETHICS_BLOCKED',
        message: `Fetch refused for ${allowed.value.host}: ${error.ethicsContext.reason}.`,
        retryable: false,
        details: { source: error.ethicsContext.source, host: allowed.value.host },
      };
    }
    throw error;
  }

  // 3. Fetch with timeout + streamed size limit.
  let doc;
  try {
    doc = await deps.fetcher.fetch(allowed.value.url, {
      timeoutMs: services.budgets.perToolTimeoutMs,
      signal,
    });
  } catch (error) {
    if (error instanceof FetchError) {
      recordFailure(services, allowed.value.url, 'fetch_failed');
      return { ok: false, ...mapFetchError(error) };
    }
    throw error;
  }

  // 4. Content-type allowlist.
  const contentType = (doc.contentType ?? '').toLowerCase();
  if (!deps.allowedContentTypes.some((prefix) => contentType.includes(prefix))) {
    recordFailure(services, allowed.value.url, 'extract_failed');
    return {
      ok: false,
      errorCode: 'CONTENT_TYPE_REFUSED',
      message: `Refusing non-text content type "${doc.contentType ?? 'unknown'}".`,
      retryable: false,
    };
  }

  // 5. Readability extraction. An empty result usually means the URL is not an
  // article: index/hub pages, media-only pages, and script-rendered shells all
  // extract to nothing. The message steers the agent toward a usable next step
  // instead of retrying the same URL.
  const article = await deps.extractor.extract(doc);
  if (article === null || article.contentText.trim().length === 0) {
    recordFailure(services, allowed.value.url, 'extract_failed');
    return {
      ok: false,
      errorCode: 'EXTRACTION_EMPTY',
      message:
        'No readable article content could be extracted from the page. It is likely an ' +
        'index/hub, media-only, or script-rendered page; fetch a specific article URL instead.',
      retryable: false,
      details: { final_url: doc.finalUrl, fetch_mode: doc.fetchMode },
    };
  }

  // The fetched page becomes ledger evidence: result_publish attaches these
  // as the Brief's sources, so the model never re-types URLs.
  services.evidence.add({
    url: article.url,
    finalUrl: doc.finalUrl === article.url ? null : doc.finalUrl,
    title: article.title,
    excerpt: article.excerpt ?? article.contentText.slice(0, 1000),
    fetchedAt: services.nowIso(),
    publishedAt: article.publishedAt,
    tool: 'web_fetch',
  });

  // 6. Large content → capture reference instead of an inline dump.
  const textBytes = Buffer.byteLength(article.contentText, 'utf8');
  if (textBytes > deps.captureThresholdBytes) {
    const captureRef = await writeCapture(services.runDir, article.contentText);
    return {
      ok: true,
      model: {
        url: article.url,
        title: article.title,
        excerpt: article.excerpt ?? article.contentText.slice(0, 1000),
        capture_ref: captureRef,
        length_chars: article.lengthChars,
        note: 'Full content stored as a capture; the excerpt is shown here.',
      },
      details: { capture_ref: captureRef, bytes: textBytes },
    };
  }

  return {
    ok: true,
    model: {
      url: article.url,
      title: article.title,
      byline: article.byline,
      published_at: article.publishedAt,
      text: article.contentText,
    },
    details: { bytes: textBytes, final_url: doc.finalUrl },
  };
}

function recordFailure(services: RunServices, url: string, reason: DomainRankReason): void {
  const domain = domainFromUrl(url);
  if (domain !== null) {
    safeRecordRankSignal(services.domain.rank, { domain, delta: -1, reason });
  }
}

/** Map a core FetchError kind to a stable tool error. */
function mapFetchError(error: FetchError): {
  readonly errorCode: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  switch (error.context.kind) {
    case 'timeout':
      return { errorCode: 'FETCH_TIMEOUT', message: 'The fetch timed out.', retryable: true };
    case 'too-large':
      return {
        errorCode: 'CONTENT_TOO_LARGE',
        message: 'The page body exceeded the size limit and was aborted.',
        retryable: false,
      };
    case 'http-status':
      return {
        errorCode: 'FETCH_HTTP_ERROR',
        message: `The server returned HTTP ${error.context.statusCode ?? '4xx/5xx'}.`,
        retryable: true,
      };
    default:
      return {
        errorCode: 'FETCH_FAILED',
        message: 'A network failure occurred while fetching the page.',
        retryable: true,
      };
  }
}
