import { describe, expect, it } from 'vitest';

import { parseSearchConfig } from '../../../src/extraction/search/config.js';
import { DEFAULT_SEARCH_CONFIG } from '../../../src/extraction/search/registry.js';

describe('@no-llm extraction/search/config', () => {
  it('yields defaults when the search block is absent', () => {
    const result = parseSearchConfig(undefined);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe('auto');
      expect(result.config.fallbackChain).toEqual(DEFAULT_SEARCH_CONFIG.fallbackChain);
    }
  });

  it('accepts a valid provider and fallback_chain', () => {
    const result = parseSearchConfig({
      provider: 'duckduckgo',
      fallback_chain: ['brave', 'duckduckgo'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe('duckduckgo');
      expect(result.config.fallbackChain).toEqual(['brave', 'duckduckgo']);
    }
  });

  it('rejects an unknown provider name', () => {
    const result = parseSearchConfig({ provider: 'bing' });

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown provider name inside the fallback_chain', () => {
    const result = parseSearchConfig({ fallback_chain: ['tavily', 'bing'] });

    expect(result.ok).toBe(false);
  });

  it('de-duplicates fallback_chain entries preserving first-occurrence order', () => {
    const result = parseSearchConfig({
      fallback_chain: ['tavily', 'brave', 'tavily', 'duckduckgo', 'brave'],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.fallbackChain).toEqual(['tavily', 'brave', 'duckduckgo']);
    }
  });

  it('allows an empty fallback_chain (resolution-time error, not a parse error)', () => {
    const result = parseSearchConfig({ provider: 'auto', fallback_chain: [] });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.fallbackChain).toEqual([]);
    }
  });

  it('accepts the "auto" provider sentinel', () => {
    const result = parseSearchConfig({ provider: 'auto' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.provider).toBe('auto');
    }
  });

  it('defaults fetch_top to 3 when the block is absent', () => {
    const result = parseSearchConfig(undefined);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.fetchTop).toBe(DEFAULT_SEARCH_CONFIG.fetchTop);
      expect(result.config.fetchTop).toBe(3);
    }
  });

  it('accepts an in-range fetch_top', () => {
    const result = parseSearchConfig({ fetch_top: 5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.fetchTop).toBe(5);
    }
  });

  it('rejects fetch_top below the minimum (0)', () => {
    expect(parseSearchConfig({ fetch_top: 0 }).ok).toBe(false);
  });

  it('rejects fetch_top above the maximum (6)', () => {
    expect(parseSearchConfig({ fetch_top: 6 }).ok).toBe(false);
  });

  it('rejects a non-integer fetch_top', () => {
    expect(parseSearchConfig({ fetch_top: 2.5 }).ok).toBe(false);
  });
});
