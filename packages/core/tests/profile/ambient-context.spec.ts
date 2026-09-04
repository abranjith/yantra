import { describe, expect, it } from 'vitest';

import {
  MAX_LOCATION_CHARS,
  resolveAmbientGrants,
  resolveUserLocation,
} from '../../src/profile/ambient-context.js';
import type {
  EffectivePreference,
  EffectivePreferences,
} from '../../src/profile/effective-preferences.js';
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

describe('@no-llm resolveAmbientGrants', () => {
  it('defaults location to true when the row is absent', () => {
    expect(resolveAmbientGrants(prefs({})).location).toBe(true);
  });

  it('defaults location to true when the row exists but is unapproved', () => {
    expect(resolveAmbientGrants(prefs({ 'context.location': [false, false] })).location).toBe(true);
  });

  it('honors an explicit approved false', () => {
    expect(resolveAmbientGrants(prefs({ 'context.location': [false, true] })).location).toBe(false);
  });

  it('honors an explicit approved true', () => {
    expect(resolveAmbientGrants(prefs({ 'context.location': [true, true] })).location).toBe(true);
  });

  it('ignores a non-boolean stored value and falls back to granted', () => {
    expect(resolveAmbientGrants(prefs({ 'context.location': ['nope', true] })).location).toBe(true);
  });

  it.each([
    ['absent', undefined],
    ['unapproved true', [true, false]],
    ['approved false', [false, true]],
    ['approved true', [true, true]],
    ['malformed string', ['yes', true]],
    ['malformed number', [1, true]],
    ['malformed null', [null, true]],
  ] as const)('resolves screenshots fail-closed for %s', (_label, entry) => {
    const effective =
      entry === undefined ? prefs({}) : prefs({ 'context.screenshots': [...entry] });
    expect(resolveAmbientGrants(effective)).toEqual({
      location: true,
      screenshots: entry?.[0] === true && entry[1] === true,
    });
  });
});

describe('@no-llm resolveUserLocation', () => {
  it('composes city and region', () => {
    const location = resolveUserLocation(
      prefs({ 'locale.city': ['Naperville, IL', true], 'locale.region': ['US', true] }),
    );
    expect(location).toBe('Naperville, IL, US');
  });

  it('returns the city alone when no region is set', () => {
    const location = resolveUserLocation(prefs({ 'locale.city': ['Naperville, IL', true] }));
    expect(location).toBe('Naperville, IL');
  });

  it('returns the region alone when no city is set', () => {
    const location = resolveUserLocation(prefs({ 'locale.region': ['US', true] }));
    expect(location).toBe('US');
  });

  it('returns null when neither is set', () => {
    expect(resolveUserLocation(prefs({}))).toBeNull();
  });

  it('returns null when the grant is denied even with a city stored', () => {
    const location = resolveUserLocation(
      prefs({ 'context.location': [false, true], 'locale.city': ['Naperville, IL', true] }),
    );
    expect(location).toBeNull();
  });

  it('returns null when the location rows exist but are unapproved', () => {
    const location = resolveUserLocation(
      prefs({ 'locale.city': ['Naperville, IL', false], 'locale.region': ['US', false] }),
    );
    expect(location).toBeNull();
  });

  it('ignores whitespace-only values', () => {
    expect(resolveUserLocation(prefs({ 'locale.city': ['   ', true] }))).toBeNull();
  });

  it('trims surrounding whitespace from a stored value', () => {
    expect(resolveUserLocation(prefs({ 'locale.city': ['  Naperville, IL  ', true] }))).toBe(
      'Naperville, IL',
    );
  });

  it('ignores a non-string stored value', () => {
    expect(
      resolveUserLocation(prefs({ 'locale.city': [{ city: 'Naperville' }, true] })),
    ).toBeNull();
  });

  it('caps a 300-char city at 120 chars', () => {
    const location = resolveUserLocation(prefs({ 'locale.city': ['a'.repeat(300), true] }));
    expect(location).not.toBeNull();
    expect((location as string).length).toBe(MAX_LOCATION_CHARS);
  });

  it('redacts a credential-shaped value via sanitize', () => {
    const secret = 'sk-ABCDEF0123456789abcdef0123';
    const location = resolveUserLocation(prefs({ 'locale.city': [secret, true] }));
    expect(location).not.toContain(secret);
  });

  it('returns a Sanitized-branded string (brand carried)', () => {
    const location = resolveUserLocation(prefs({ 'locale.city': ['Naperville, IL', true] }));
    if (location === null) throw new Error('expected a value');
    // Type-level: the returned value satisfies the Sanitized<string> slot.
    const branded: Sanitized<string> = location;
    expect(typeof branded).toBe('string');
  });

  it('accepts preferences only — history rows are not a valid input (compile guard)', () => {
    // @ts-expect-error the resolver takes EffectivePreferences, never history rows
    const badLocation = () => resolveUserLocation([{ intentText: 'my private query' }]);
    // @ts-expect-error the resolver takes EffectivePreferences, never history rows
    const badGrants = () => resolveAmbientGrants([{ intentText: 'my private query' }]);
    expect(typeof badLocation).toBe('function');
    expect(typeof badGrants).toBe('function');
  });
});
