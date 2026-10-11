/**
 * The one place a `web_search` provider failure becomes a tool result
 * (FEAT-048 TASK-002).
 *
 * Before this table, a bare `catch {}` turned every provider failure into
 * "temporarily unavailable, retryable". Run `20260925T130634Z` lost 11 typed
 * causes that way (anti-bot challenges and empty result sets), and the model,
 * told to retry, issued more concurrent searches into the same challenge.
 *
 * Rules, all load-bearing:
 *
 * 1. Classification is by `instanceof` against the real exported core classes
 *    first, then `context.code`, then `statusCode`, in table order. Subclasses
 *    precede their parent.
 * 2. The model-visible message is a registered template, never the core
 *    error's prose: provider messages embed setup commands, response-parse
 *    exception text, and ethics detail strings.
 * 3. The `cause` is a closed vocabulary ({@link SEARCH_FAILURE_CAUSES}). Raw
 *    codes that embed text (`parse-error:<message>`,
 *    `ethics-refused:<reason>:<detail>`) are normalized and never copied.
 * 4. `retryable` is true only where an identical or reformulated call can
 *    plausibly succeed within this run.
 */

import {
  NoSearchProviderAvailableError,
  RateLimitError,
  ScrapeSearchError,
  SearchProviderError,
  SearchProviderKeyMissingError,
  TavilyAuthError,
  UnknownSearchProviderError,
} from '@yantra/core';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure } from '../../../runtime/middleware.js';

import { mapBrowserStartupError } from './browser-startup-errors.js';

/** Stable `web_search` failure codes. */
export type SearchErrorCode =
  | 'SEARCH_BLOCKED'
  | 'SEARCH_NO_RESULTS'
  | 'SEARCH_TIMEOUT'
  | 'SEARCH_PROVIDER_UNAVAILABLE'
  | 'SEARCH_FAILED';

/**
 * The closed `web_search` cause vocabulary. Two entries are parametric:
 * `ethics-refused:<reason>` (an ethics `BlockedReason`) and
 * `unexpected:<ErrorClass>` (an error class name).
 */
export const SEARCH_FAILURE_CAUSES = Object.freeze([
  'anomaly-challenge',
  'rate-limited',
  'empty-results',
  'timeout',
  'ethics-refused:<reason>',
  'key-missing',
  'no-provider-available',
  'unknown-provider',
  'auth-rejected',
  'http-5xx',
  'http-4xx',
  'invalid-response',
  'serp-fetch-failed',
  'aborted',
  'browser-startup',
  'unexpected:<ErrorClass>',
] as const);

const ETHICS_REASONS: ReadonlySet<string> = new Set(['robots', 'blocklist', 'rate-limit']);
const ERROR_CLASS_RE = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * True when `cause` belongs to the declared `web_search` vocabulary.
 *
 * @param cause A diagnostic cause emitted by {@link mapSearchError}.
 */
export function isSearchFailureCause(cause: string): boolean {
  if ((SEARCH_FAILURE_CAUSES as readonly string[]).includes(cause)) return !cause.includes('<');
  const ethics = /^ethics-refused:(.+)$/.exec(cause);
  if (ethics) return ETHICS_REASONS.has(ethics[1] ?? '');
  const unexpected = /^unexpected:(.+)$/.exec(cause);
  if (unexpected) return ERROR_CLASS_RE.test(unexpected[1] ?? '');
  return false;
}

/**
 * Map anything `web_search` caught (a provider search throw or a
 * provider-resolution failure) to a stable, cause-specific tool failure.
 *
 * @param error The caught value.
 * @param provider The resolved provider's name, or null when resolution itself failed.
 * @returns A {@link DomainFailure} carrying an operator-only diagnostic.
 */
export function mapSearchError(error: unknown, provider: string | null): DomainFailure {
  const name = provider ?? providerOf(error) ?? 'the search provider';
  const row = classify(error);
  if (row.kind === 'browser') {
    // A SERP browser that will not start is the FEAT-047 condition; its
    // message and code are owned by that table.
    return {
      ...row.failure,
      diagnostic: { cause: 'browser-startup', ...providerField(provider ?? providerOf(error)) },
    };
  }
  const details = { provider: name, ...(row.reason === undefined ? {} : { reason: row.reason }) };
  return {
    ok: false,
    errorCode: row.code,
    message: renderAgentMessage('tool', row.code, row.template, details),
    retryable: row.retryable,
    details: { provider: name, cause: row.cause },
    diagnostic: { cause: row.cause, ...providerField(provider ?? providerOf(error)) },
  };
}

type Row =
  | { readonly kind: 'browser'; readonly failure: DomainFailure }
  | {
      readonly kind: 'search';
      readonly code: SearchErrorCode;
      readonly retryable: boolean;
      readonly cause: string;
      /** Message-template cause (the parametric causes share one template). */
      readonly template: string;
      readonly reason?: string;
    };

function search(
  code: SearchErrorCode,
  retryable: boolean,
  cause: string,
  template = cause,
  reason?: string,
): Row {
  return {
    kind: 'search',
    code,
    retryable,
    cause,
    template,
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The ordered classification table (spec §TASK-002). */
function classify(error: unknown): Row {
  if (error instanceof ScrapeSearchError) {
    const code = error.context.code ?? '';
    if (code === 'anomaly-challenge') return search('SEARCH_BLOCKED', false, 'anomaly-challenge');
    if (code === 'empty-results') return search('SEARCH_NO_RESULTS', true, 'empty-results');
    if (namesTimeout(code)) return search('SEARCH_TIMEOUT', true, 'timeout');
    if (code.startsWith('ethics-refused:')) {
      const reason = code.split(':')[1] ?? '';
      const safeReason = ETHICS_REASONS.has(reason) ? reason : 'blocklist';
      return search(
        'SEARCH_PROVIDER_UNAVAILABLE',
        false,
        `ethics-refused:${safeReason}`,
        'ethics-refused',
        safeReason,
      );
    }
    if (code === 'aborted') return search('SEARCH_FAILED', false, 'aborted');
    return search('SEARCH_FAILED', true, 'serp-fetch-failed');
  }
  if (error instanceof RateLimitError) return search('SEARCH_BLOCKED', false, 'rate-limited');
  if (error instanceof SearchProviderKeyMissingError) {
    return search('SEARCH_PROVIDER_UNAVAILABLE', false, 'key-missing');
  }
  if (error instanceof NoSearchProviderAvailableError) {
    return search('SEARCH_PROVIDER_UNAVAILABLE', false, 'no-provider-available');
  }
  if (error instanceof UnknownSearchProviderError) {
    return search('SEARCH_PROVIDER_UNAVAILABLE', false, 'unknown-provider');
  }
  if (error instanceof TavilyAuthError) {
    // Keyed HTTP providers raise their auth class for a key absent at search
    // time as well as for a key the service rejected.
    return error.context.code === 'missing-api-key'
      ? search('SEARCH_PROVIDER_UNAVAILABLE', false, 'key-missing')
      : search('SEARCH_PROVIDER_UNAVAILABLE', false, 'auth-rejected');
  }
  if (error instanceof SearchProviderError) {
    if (namesTimeout(error.context.code ?? '')) return search('SEARCH_TIMEOUT', true, 'timeout');
    const status = error.context.statusCode;
    if (status !== undefined && status >= 500) {
      return search('SEARCH_PROVIDER_UNAVAILABLE', true, 'http-5xx');
    }
    if (status !== undefined && status >= 400) return search('SEARCH_FAILED', false, 'http-4xx');
    return search('SEARCH_FAILED', false, 'invalid-response');
  }
  const browser = mapBrowserStartupError(error);
  if (browser !== null) return { kind: 'browser', failure: browser };
  return search('SEARCH_FAILED', false, `unexpected:${errorClassOf(error)}`, 'unexpected');
}

function namesTimeout(code: string): boolean {
  return /timeout/i.test(code);
}

function providerOf(error: unknown): string | null {
  return error instanceof SearchProviderError ? error.context.provider : null;
}

function providerField(provider: string | null): { readonly provider?: string } {
  return provider === null ? {} : { provider };
}

function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : 'NonError';
  return ERROR_CLASS_RE.test(name) ? name : 'Error';
}
