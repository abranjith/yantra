import { z } from 'zod';

import { loadConfig } from '../../config/load.js';
import type { SearchProviderName } from '../types.js';

import { DEFAULT_SEARCH_CONFIG, SEARCH_PROVIDER_NAMES, type SearchConfig } from './registry.js';

const providerNameSchema = z.enum(
  SEARCH_PROVIDER_NAMES as [SearchProviderName, ...SearchProviderName[]],
);

export const searchConfigSchema = z
  .object({
    provider: z.union([providerNameSchema, z.literal('auto')]).default('auto'),
    fallback_chain: z
      .array(providerNameSchema)
      .default([...DEFAULT_SEARCH_CONFIG.fallbackChain])
      .transform((chain) => [...new Set(chain)]),
    fetch_top: z.number().int().min(1).max(5).default(DEFAULT_SEARCH_CONFIG.fetchTop),
  })
  .transform(
    (raw): SearchConfig => ({
      provider: raw.provider,
      fallbackChain: raw.fallback_chain,
      fetchTop: raw.fetch_top,
    }),
  );

export type SearchConfigParseResult =
  | { readonly ok: true; readonly config: SearchConfig }
  | { readonly ok: false; readonly error: z.ZodError };

export function parseSearchConfig(raw: unknown): SearchConfigParseResult {
  const result = searchConfigSchema.safeParse(raw ?? {});
  return result.success ? { ok: true, config: result.data } : { ok: false, error: result.error };
}

/** Loads search configuration through the shared strict config loader. */
export async function loadSearchConfig(): Promise<SearchConfig> {
  const loaded = await loadConfig();
  if (!loaded.isOk) throw loaded.error;
  const search = loaded.value.search;
  return {
    provider: search.provider,
    fallbackChain: search.fallback_chain,
    fetchTop: search.fetch_top,
  };
}
