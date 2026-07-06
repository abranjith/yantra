import { describe, expect, it } from 'vitest';

import type {
  EffectivePreference,
  EffectivePreferences,
} from '../../src/profile/effective-preferences.js';
import {
  MAX_CONTEXT_CHARS,
  buildPersonalizationContext,
} from '../../src/profile/personalization.js';
import type { Sanitized } from '../../src/sanitizer/brand.js';

/** Builds an effective-preferences map from `{ key: [value, approved] }`. */
function prefs(entries: Record<string, [unknown, boolean]>): EffectivePreferences {
  const map = new Map<string, EffectivePreference>();
  for (const [key, [value, approved]] of Object.entries(entries)) {
    map.set(key, {
      key,
      value,
      source: approved ? 'user' : 'learned',
      approved,
      provenance: approved ? 'profile.yaml' : 'index.db',
    });
  }
  return map;
}

describe('@no-llm buildPersonalizationContext', () => {
  it('returns null when personalization is explicitly disabled', () => {
    const result = buildPersonalizationContext(
      prefs({
        'personalization.enabled': [false, true],
        'locale.units': ['metric', true],
      }),
    );
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBeNull();
  });

  it('returns null when nothing approved is available', () => {
    const result = buildPersonalizationContext(prefs({}));
    expect(result.isOk).toBe(true);
    if (result.isOk) expect(result.value).toBeNull();
  });

  it('composes declarative lines from approved values', () => {
    const result = buildPersonalizationContext(
      prefs({
        'locale.units': ['metric', true],
        'personalization.favorite_retailers': [['Amazon', 'Best Buy'], true],
      }),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value).toContain('Prefers metric units.');
    expect(result.value).toContain('Favors retailers: Amazon, Best Buy.');
  });

  it('excludes unapproved learned rows', () => {
    const result = buildPersonalizationContext(
      prefs({
        'locale.units': ['metric', true],
        'personalization.favorite_retailers': [['SecretShop'], false], // learned, unapproved
      }),
    );
    if (!result.isOk) throw new Error('expected ok');
    expect(result.value).toContain('metric');
    expect(result.value).not.toContain('SecretShop');
  });

  it('enforces the 400-char cap at a line boundary', () => {
    const longRetailers = Array.from({ length: 60 }, (_, i) => `retailer-number-${i}`);
    const result = buildPersonalizationContext(
      prefs({
        'locale.units': ['metric', true],
        'personalization.favorite_retailers': [longRetailers, true],
      }),
    );
    if (!result.isOk) throw new Error('expected ok');
    expect(result.value).not.toBeNull();
    expect((result.value as string).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    // The short "Prefers metric units." line fits; the oversized retailer line is dropped whole.
    expect(result.value).toContain('Prefers metric units.');
    expect(result.value).not.toContain('retailer-number-59');
  });

  it('strips a credential-shaped injection in a pref value via sanitize', () => {
    const secret = 'sk-ABCDEF0123456789abcdef0123';
    const result = buildPersonalizationContext(
      prefs({
        'personalization.favorite_retailers': [[secret], true],
      }),
    );
    if (!result.isOk) throw new Error('expected ok');
    expect(result.value).not.toContain(secret);
  });

  it('the output is assignable where a Sanitized<string> is required (brand carried)', () => {
    const result = buildPersonalizationContext(prefs({ 'locale.units': ['metric', true] }));
    if (!result.isOk || result.value === null) throw new Error('expected a value');
    // Type-level: the returned value satisfies the Sanitized<string> slot.
    const branded: Sanitized<string> = result.value;
    expect(typeof branded).toBe('string');
  });

  it('accepts preferences only — history rows are not a valid input (compile guard)', () => {
    // @ts-expect-error the builder takes EffectivePreferences, never history rows
    const bad = () => buildPersonalizationContext([{ intentText: 'my private query' }]);
    expect(typeof bad).toBe('function');
  });
});
