import { KNOWN_CONFIG_KEYS, KNOWN_PREFERENCE_KEYS } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { keyOwner, keyOwnershipEntries } from '../src/key-ownership.js';

describe('@no-llm key ownership', () => {
  it('assigns every schema key to exactly one owner', () => {
    const entries = keyOwnershipEntries();
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...KNOWN_CONFIG_KEYS, ...KNOWN_PREFERENCE_KEYS].sort());
    for (const key of KNOWN_CONFIG_KEYS) expect(keyOwner(key)).toBe('config');
    for (const key of KNOWN_PREFERENCE_KEYS) expect(keyOwner(key)).toBe('prefs');
  });
});
