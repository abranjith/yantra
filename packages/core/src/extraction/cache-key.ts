import { createHash } from 'node:crypto';

import type { SearchProviderName } from './types.js';

/**
 * Normalizes a query into a deterministic cache-key fragment.
 */
export function normalizeQueryForCache(query: string): string {
  return query.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Computes the UTC day component used by the ask cache key.
 */
export function utcDayFrom(dateIso: string): string {
  return dateIso.slice(0, 10);
}

/**
 * Builds a stable SHA-256 cache key for ask responses.
 */
export function cacheKey(query: string, provider: SearchProviderName, utcDay: string): string {
  const normalized = normalizeQueryForCache(query);
  return createHash('sha256').update(`${normalized}|${provider}|${utcDay}`).digest('hex');
}
