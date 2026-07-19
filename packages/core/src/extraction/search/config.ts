import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { configPath } from '../../browser/paths.js';
import type { SearchProviderName } from '../types.js';

import { DEFAULT_SEARCH_CONFIG, SEARCH_PROVIDER_NAMES, type SearchConfig } from './registry.js';

const providerNameSchema = z.enum(
  SEARCH_PROVIDER_NAMES as [SearchProviderName, ...SearchProviderName[]],
);

/**
 * Zod schema for the `search:` block of `config.yaml`. Unknown provider names
 * fail validation (startup exit 1). `fallback_chain` entries are de-duplicated
 * (first occurrence wins) while preserving order. An empty chain is accepted
 * here — it is a valid config that only surfaces as a resolution-time error when
 * `auto` has nowhere to walk. `fetch_top` (how many top hits the combined
 * `web_search` tool fetches inline) is an integer in `[1, 5]`, default 3;
 * out-of-range or non-integer values fail validation (startup exit 1).
 */
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

/**
 * Validates a raw `search:` config object against {@link searchConfigSchema}.
 * Returns a discriminated result rather than throwing, so callers can decide
 * whether an invalid config is fatal (CLI startup → exit 1) or ignorable.
 *
 * @param raw The parsed `search:` sub-object from `config.yaml` (may be
 *   `undefined` when the block is absent — yields defaults).
 */
export function parseSearchConfig(raw: unknown): SearchConfigParseResult {
  const result = searchConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    return { ok: false, error: result.error };
  }
  return { ok: true, config: result.data };
}

/**
 * Loads and validates the search config from `~/.config/yantra/config.yaml`.
 *
 * A missing file or absent `search:` block yields {@link DEFAULT_SEARCH_CONFIG}.
 * A present-but-invalid `search:` block throws — misconfiguration must fail loud
 * at startup (memory §Error Handling: validation class, exit 1).
 *
 * @throws {Error} when the `search:` block fails Zod validation.
 */
export async function loadSearchConfig(): Promise<SearchConfig> {
  let raw: Record<string, unknown> | undefined;
  try {
    const { parse } = await import('yaml');
    const contents = await readFile(configPath(), 'utf8');
    raw = parse(contents) as Record<string, unknown>;
  } catch {
    // No config file (or unreadable/unparseable YAML) → defaults. A malformed
    // top-level file is out of this feature's scope; ethics config degrades the
    // same way.
    return DEFAULT_SEARCH_CONFIG;
  }

  const result = parseSearchConfig(raw?.search);
  if (!result.ok) {
    throw new Error(
      `Invalid search config in ${configPath()}: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.config;
}
