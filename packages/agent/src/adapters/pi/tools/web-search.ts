/**
 * `web_search` tool spec (FEAT-024 TASK-004, plan_agentic.md §5).
 *
 * A thin wrapper over the existing `@yantra/core` search provider registry. The
 * spec is provider-neutral (no Pi SDK import); the middleware supplies input
 * validation, result bounding, sanitization, stable errors, and audit. Search
 * snippets are untrusted input (an injection vector — plan §11 fixture 9), so
 * the whole result is passed through the sanitizer by the middleware before the
 * model ever sees it.
 */

import { Type, type Static } from 'typebox';

import type { DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

/** Absolute ceiling on the number of results returned to the model. */
const HARD_RESULT_CAP = 10;

const WebSearchParams = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 400,
      description: 'The search query. Plain keywords or a natural-language question.',
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: HARD_RESULT_CAP,
        description: `Maximum results to return (1–${HARD_RESULT_CAP}).`,
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
      'Search the public web and return a ranked list of {url, title, snippet} results. ' +
      'Use it to discover candidate sources for a public question. Do NOT use it to read a ' +
      "page's full content (use web_fetch for that), and do NOT use it for authenticated, " +
      'private, or logged-in data.',
    parameters: WebSearchParams,
    sanitizationProfile: 'public',
    run: (params: WebSearchParamsType, ctx): Promise<DomainResult> => runWebSearch(params, ctx.services, ctx.signal),
  };
}

async function runWebSearch(
  params: WebSearchParamsType,
  services: RunServices,
  signal: AbortSignal,
): Promise<DomainResult> {
  const deps = services.domain.search;
  const cap = Math.min(params.limit ?? deps.resultCap, deps.resultCap, HARD_RESULT_CAP);

  const resolved = await deps.resolveProvider();
  if (!resolved.isOk) {
    return {
      ok: false,
      errorCode: 'SEARCH_PROVIDER_UNAVAILABLE',
      message: resolved.error.message,
      retryable: true,
    };
  }

  let hits;
  try {
    hits = await resolved.value.search(params.query, { limit: cap, signal });
  } catch {
    // Provider unavailability or transport failure is retryable, never a crash.
    return {
      ok: false,
      errorCode: 'SEARCH_FAILED',
      message: 'The search provider failed or is temporarily unavailable.',
      retryable: true,
    };
  }

  const results = hits.slice(0, cap).map((hit) => ({
    url: hit.url,
    title: hit.title,
    snippet: hit.snippet,
  }));

  return {
    ok: true,
    model: { query: params.query, result_count: results.length, results },
    details: { provider: resolved.value.name, requested: cap },
  };
}
