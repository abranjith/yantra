import pino, { type DestinationStream } from 'pino';

import { loadConfig } from '../config/load.js';
import { parseConfigRef, type ConfigRef } from '../config/refs.js';

import { KeychainUnavailableError } from './errors.js';
import { YANTRA_KEYCHAIN_SERVICE, type KeychainProvider } from './keychain.js';

export const CREDENTIAL_MAX_BYTES = 8192;

export class CredentialKeyInvalidError extends Error {
  override readonly name = 'CredentialKeyInvalidError';
}

export class CredentialValueInvalidError extends Error {
  override readonly name = 'CredentialValueInvalidError';
}

/** Validate an account name using the configuration reference grammar. */
export function validateCredentialKey(key: string): void {
  const parsed = parseConfigRef(`\${secret:${key}}`);
  if (!parsed.isOk)
    throw new CredentialKeyInvalidError(`${parsed.error}; expected a key such as tavily.api_key`);
}

/** Platform-specific steps for recovering from an unavailable keychain. */
export function keychainRemedy(platform = process.platform): string {
  const remedy =
    platform === 'linux'
      ? 'install libsecret and start a Secret Service'
      : platform === 'darwin'
        ? 'unlock the login keychain'
        : 'enable Windows Credential Manager';
  return `${remedy}, or use a \${env:NAME} reference`;
}

type CredentialSource = 'keychain' | 'env' | 'absent';

export interface CredentialReference {
  readonly kind: 'model' | 'search';
  readonly id: string;
  readonly ref: ConfigRef;
}

export interface CredentialRow {
  readonly key: string;
  readonly source: CredentialSource;
  readonly referenced_by: readonly CredentialReference[];
}

export interface CredentialListResult {
  readonly available: boolean;
  readonly remedy: string | null;
  readonly rows: readonly CredentialRow[];
}

export interface CredentialServiceDeps {
  readonly keychain: KeychainProvider;
  readonly env: NodeJS.ProcessEnv;
  readonly loadConfig?: typeof loadConfig;
  readonly logDestination?: DestinationStream;
  readonly logLevel?: string;
}

/** Shared write-only operations for terminal and in-process callers. */
export function createCredentialService(deps: CredentialServiceDeps) {
  const { keychain, env } = deps;
  const log = pino(
    {
      name: 'yantra.credentials',
      level: deps.logLevel ?? env.YANTRA_LOG_LEVEL ?? 'info',
      redact: ['value', '*.value'],
    },
    deps.logDestination,
  );

  function unavailable(operation: 'set' | 'delete' | 'list'): KeychainUnavailableError {
    return new KeychainUnavailableError(`OS keychain unavailable; ${keychainRemedy()}`, {
      operation,
    });
  }

  // Native provider error messages are untrusted and may contain request values.
  async function perform<T>(
    operation: 'set' | 'delete' | 'list',
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch {
      throw unavailable(operation);
    }
  }

  async function requireAvailable(operation: 'set' | 'delete'): Promise<void> {
    if (!(await perform(operation, () => keychain.isAvailable()))) throw unavailable(operation);
  }

  return {
    requireAvailable,
    async setCredential({ key, value }: { readonly key: string; readonly value: string }) {
      validateCredentialKey(key);
      if (!value) throw new CredentialValueInvalidError('secret value must not be empty');
      if (Buffer.byteLength(value, 'utf8') > CREDENTIAL_MAX_BYTES)
        throw new CredentialValueInvalidError('secret value must not exceed 8 KiB');
      await requireAvailable('set');
      await perform('set', () => keychain.set(YANTRA_KEYCHAIN_SERVICE, key, value));
      log.debug({ op: 'set', key });
      return { status: 'set', key } as const;
    },
    async removeCredential({ key }: { readonly key: string }) {
      validateCredentialKey(key);
      await requireAvailable('delete');
      const removed = await perform('delete', () => keychain.delete(YANTRA_KEYCHAIN_SERVICE, key));
      log.debug({ op: 'rm', key });
      return { status: removed ? 'removed' : 'absent', key } as const;
    },
    async listCredentials(): Promise<CredentialListResult> {
      const available = await perform('list', () => keychain.isAvailable());
      const stored = available
        ? await perform('list', () => keychain.list(YANTRA_KEYCHAIN_SERVICE))
        : [];
      const rows = new Map<string, CredentialRow>();
      for (const { account } of stored)
        rows.set(account, { key: account, source: 'keychain', referenced_by: [] });
      function add(
        key: string,
        kind: CredentialReference['kind'],
        id: string,
        ref: ConfigRef | null,
      ): void {
        const existing = rows.get(key);
        const source =
          ref?.kind === 'env' ? (env[ref.name] ? 'env' : 'absent') : (existing?.source ?? 'absent');
        const references = existing?.referenced_by ?? [];
        rows.set(key, {
          key,
          source,
          referenced_by: ref ? [...references, { kind, id, ref }] : references,
        });
      }
      const loaded = await (deps.loadConfig ?? loadConfig)();
      if (loaded.isOk) {
        for (const provider of ['tavily', 'brave'] as const) {
          const ref = loaded.value.search[provider].api_key;
          add(ref?.kind === 'secret' ? ref.key : `${provider}.api_key`, 'search', provider, ref);
        }
        for (const model of loaded.value.models) {
          const ref = model.api_key;
          const id = `${model.provider}/${model.id}`;
          if (ref) add(ref.kind === 'secret' ? ref.key : id, 'model', id, ref);
        }
      }
      log.debug({ op: 'list' });
      return {
        available,
        remedy: available ? null : keychainRemedy(),
        rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)),
      };
    },
  };
}
