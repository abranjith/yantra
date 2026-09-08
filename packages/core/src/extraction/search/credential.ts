import { loadConfig } from '../../config/load.js';
import type { ConfigRef } from '../../config/refs.js';
import { resolveConfigRef } from '../../config/refs.js';
import type { KeychainProvider } from '../../secrets/keychain.js';
import { YANTRA_KEYCHAIN_SERVICE } from '../../secrets/keychain.js';

export interface SearchCredential {
  readonly value: string;
  readonly source: 'env' | 'keychain';
}

/** Resolves a search credential at the request boundary, never during config loading. */
export async function resolveSearchCredential(
  provider: 'tavily' | 'brave',
  keychain: KeychainProvider,
  service: string = YANTRA_KEYCHAIN_SERVICE,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchCredential | null> {
  const loaded = await loadConfig();
  if (!loaded.isOk) throw loaded.error;
  const ref: ConfigRef | null = loaded.value.search[provider].api_key;
  if (ref) {
    const resolved = await resolveConfigRef(ref, { env, keychain, keychainService: service });
    if (!resolved.isOk) return null;
    return { value: resolved.value, source: ref.kind === 'env' ? 'env' : 'keychain' };
  }
  const value = await keychain.get(service, `${provider}.api_key`);
  return value ? { value, source: 'keychain' } : null;
}
