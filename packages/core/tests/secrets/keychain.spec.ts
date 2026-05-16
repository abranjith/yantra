import { describe, expect, it } from 'vitest';

import {
  createKeychainProvider,
  YANTRA_KEYCHAIN_SERVICE,
  type KeychainProvider,
} from '../../src/secrets/keychain.js';

describe('@no-llm keychain provider', () => {
  it('creates a working provider when keytar-like module loads', async () => {
    const store = new Map<string, string>();

    const provider = await createKeychainProvider(async () => ({
      getPassword: async (service: string, account: string) => store.get(`${service}:${account}`) ?? null,
      setPassword: async (service: string, account: string, value: string) => {
        store.set(`${service}:${account}`, value);
      },
      deletePassword: async (service: string, account: string) =>
        store.delete(`${service}:${account}`),
      findCredentials: async (service: string) =>
        [...store.keys()]
          .filter((full) => full.startsWith(`${service}:`))
          .map((full) => ({ account: full.slice(service.length + 1), password: 'masked' })),
    }));

    await provider.set(YANTRA_KEYCHAIN_SERVICE, 'bank.password', 'pw-123');
    const loaded = await provider.get(YANTRA_KEYCHAIN_SERVICE, 'bank.password');
    const listed = await provider.list(YANTRA_KEYCHAIN_SERVICE);
    const removed = await provider.delete(YANTRA_KEYCHAIN_SERVICE, 'bank.password');

    expect(await provider.isAvailable()).toBe(true);
    expect(loaded).toBe('pw-123');
    expect(listed).toEqual([{ account: 'bank.password' }]);
    expect(removed).toBe(true);
  });

  it('falls back to unavailable provider when loader throws', async () => {
    const provider = await createKeychainProvider(async () => {
      throw new Error('missing native keyring');
    });

    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.get(YANTRA_KEYCHAIN_SERVICE, 'bank.password')).toBeNull();
    await expect(provider.set(YANTRA_KEYCHAIN_SERVICE, 'bank.password', 'pw')).rejects.toThrow();
    await expect(provider.delete(YANTRA_KEYCHAIN_SERVICE, 'bank.password')).rejects.toThrow();
    await expect(provider.list(YANTRA_KEYCHAIN_SERVICE)).resolves.toEqual([]);
  });

  it('@requires-keychain round-trips against real keychain when available', async () => {
    const provider: KeychainProvider = await createKeychainProvider();
    if (!(await provider.isAvailable())) {
      return;
    }

    const account = `yantra-test-${Date.now()}`;
    await provider.set(YANTRA_KEYCHAIN_SERVICE, account, 'sentinel-value');

    const loaded = await provider.get(YANTRA_KEYCHAIN_SERVICE, account);
    expect(loaded).toBe('sentinel-value');

    await provider.delete(YANTRA_KEYCHAIN_SERVICE, account);
  });
});
