import type { EffectivePreference, EffectivePreferences } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { resolveAskDefaults } from './ask.js';

function prefs(entries: Record<string, unknown>): EffectivePreferences {
  const map = new Map<string, EffectivePreference>();
  for (const [key, value] of Object.entries(entries)) {
    map.set(key, { key, value, source: 'user', approved: true, provenance: 'profile.yaml' });
  }
  return map;
}

describe('@no-llm resolveAskDefaults (flag > prefs > hardcoded)', () => {
  it('uses hardcoded defaults when nothing is set', () => {
    const resolved = resolveAskDefaults({}, new Map());
    expect(resolved).toEqual({ detail: 'standard', length: 'medium', provider: null });
  });

  it('falls back to preference values when the flag is unset', () => {
    const resolved = resolveAskDefaults(
      {},
      prefs({
        'defaults.detail': 'full',
        'defaults.length': 'long',
        'defaults.search_provider': 'brave',
      }),
    );
    expect(resolved).toEqual({ detail: 'full', length: 'long', provider: 'brave' });
  });

  it('lets an explicit flag win over the preference', () => {
    const resolved = resolveAskDefaults(
      { detail: 'overview', length: 'short', searchProvider: 'tavily' },
      prefs({
        'defaults.detail': 'full',
        'defaults.length': 'long',
        'defaults.search_provider': 'brave',
      }),
    );
    expect(resolved).toEqual({ detail: 'overview', length: 'short', provider: 'tavily' });
  });

  it('maps a preferred search_provider of "auto" to null', () => {
    const resolved = resolveAskDefaults({}, prefs({ 'defaults.search_provider': 'auto' }));
    expect(resolved.provider).toBeNull();
  });
});
