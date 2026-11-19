/**
 * Host RPC handlers for credentials (`secret.list`, `secret.set`, `secret.rm`).
 *
 * FEAT-071 TASK-002 (plan_ui D2 / §6 `in-process-secure`):
 * - Secret values are written in the host process through the shared core
 *   credential service; they never enter `command.invoke` or any child argv.
 * - Responses never echo secret values; JSON-RPC errors carry only
 *   `{code, message, remediation}`.
 * - Successful mutations log `credential_changed {op, key}` to `host.log`.
 */

import {
  CredentialKeyInvalidError,
  CredentialValueInvalidError,
  KeychainUnavailableError,
  createCredentialService,
  createKeychainProvider,
  keychainRemedy,
  type loadConfig,
  type KeychainProvider,
} from '@yantra/core';
import {
  CredentialListResult,
  EmptyParams,
  SecretRemoveRequest,
  SecretRemoveResponse,
  SecretSetRequest,
  SecretSetResponse,
} from '@yantra/protocol';

import { SILENT_HOST_LOGGER, type HostLogger } from './host.js';
import { RpcError, type RpcMethodRegistry } from './rpc-server.js';

export interface CredentialsHandlerDeps {
  readonly keychain?: KeychainProvider;
  readonly env?: NodeJS.ProcessEnv;
  readonly loadConfig?: typeof loadConfig;
  readonly logger?: HostLogger;
}

/** Registers `secret.list`, `secret.set` and `secret.rm` on the host RPC dispatcher. */
export function registerCredentials(
  methods: RpcMethodRegistry,
  deps: CredentialsHandlerDeps = {},
): void {
  const logger = deps.logger ?? SILENT_HOST_LOGGER;
  let cachedService: ReturnType<typeof createCredentialService> | null = null;

  async function getService() {
    if (cachedService !== null) return cachedService;
    const keychain = deps.keychain ?? (await createKeychainProvider());
    cachedService = createCredentialService({
      keychain,
      env: deps.env ?? {},
      ...(deps.loadConfig === undefined ? {} : { loadConfig: deps.loadConfig }),
    });
    return cachedService;
  }

  function mapError(error: unknown): never {
    if (
      error instanceof CredentialKeyInvalidError ||
      error instanceof CredentialValueInvalidError
    ) {
      throw new RpcError(
        'invalid_params',
        error.message,
        'Provide a valid credential key (such as tavily.api_key) and a non-empty value up to 8 KiB.',
      );
    }
    if (error instanceof KeychainUnavailableError) {
      throw new RpcError('not_allowed', error.message, keychainRemedy());
    }
    throw error;
  }

  methods
    .register('secret.list', {
      params: EmptyParams,
      result: CredentialListResult,
      handler: async () => {
        try {
          return await (await getService()).listCredentials();
        } catch (error) {
          return mapError(error);
        }
      },
    })
    .register('secret.set', {
      params: SecretSetRequest,
      result: SecretSetResponse,
      handler: async ({ key, value }) => {
        try {
          const result = await (await getService()).setCredential({ key, value });
          logger.info({ op: 'set', key }, 'credential_changed');
          return result;
        } catch (error) {
          return mapError(error);
        }
      },
    })
    .register('secret.rm', {
      params: SecretRemoveRequest,
      result: SecretRemoveResponse,
      handler: async ({ key }) => {
        try {
          const result = await (await getService()).removeCredential({ key });
          logger.info({ op: 'rm', key }, 'credential_changed');
          return result;
        } catch (error) {
          return mapError(error);
        }
      },
    });
}
