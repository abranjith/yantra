import { KNOWN_CONFIG_KEYS, KNOWN_PREFERENCE_KEYS } from '@yantra/core';

export type KeyOwner = 'config' | 'prefs';

const ownership = new Map<string, KeyOwner>([
  ...KNOWN_CONFIG_KEYS.map((key) => [key, 'config'] as const),
  ...KNOWN_PREFERENCE_KEYS.map((key) => [key, 'prefs'] as const),
]);

export function keyOwner(key: string): KeyOwner | undefined {
  return ownership.get(key);
}

export function keyOwnershipEntries(): readonly (readonly [string, KeyOwner])[] {
  return [...ownership.entries()];
}
