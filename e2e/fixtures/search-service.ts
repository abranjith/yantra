/**
 * The run search service over one fixture provider, for e2e suites that build
 * their own agentic environment (FEAT-050).
 *
 * Production builds one `SearchService` per run; these suites hand-build the
 * environment, so they build the service the same way: gate, breaker, and
 * memoized resolution are the real ones. A fixture that never searches passes
 * an unused resolution failure.
 */

import {
  SearchService,
  UnknownSearchProviderError,
  type Logger,
  type SearchProvider,
  type SearchProviderError,
} from '@yantra/core';
import { err, ok } from '@yantra/protocol';

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/**
 * @param provider The fixture provider, or the resolution failure to report.
 *   Defaults to a failure, for suites whose runs never search.
 */
export function fixtureSearchService(
  provider: SearchProvider | SearchProviderError = new UnknownSearchProviderError('unused'),
): SearchService {
  return new SearchService({
    resolve: () => Promise.resolve(provider instanceof Error ? err(provider) : ok(provider)),
    logger: silent,
  });
}
