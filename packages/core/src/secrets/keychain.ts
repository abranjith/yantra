import pino from 'pino';

import { KeychainUnavailableError } from './errors.js';

export const YANTRA_KEYCHAIN_SERVICE = 'yantra' as const;

export interface KeychainProvider {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
  list(service: string): Promise<readonly { account: string }[]>;
  isAvailable(): Promise<boolean>;
}

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}

const logger = pino({
  name: 'yantra.keychain',
  level: process.env.YANTRA_LOG_LEVEL ?? 'info',
  redact: {
    paths: ['password', '*.password', 'value', '*.value'],
    censor: '[REDACTED]',
  },
});

let warnedUnavailable = false;

class KeytarProvider implements KeychainProvider {
  public constructor(private readonly keytar: KeytarModule) {}

  public get(service: string, account: string): Promise<string | null> {
    return this.keytar.getPassword(service, account);
  }

  public set(service: string, account: string, value: string): Promise<void> {
    return this.keytar.setPassword(service, account, value);
  }

  public delete(service: string, account: string): Promise<boolean> {
    return this.keytar.deletePassword(service, account);
  }

  public async list(service: string): Promise<readonly { account: string }[]> {
    const credentials = await this.keytar.findCredentials(service);
    return credentials.map((item) => ({ account: item.account }));
  }

  public isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class UnavailableKeychainProvider implements KeychainProvider {
  public constructor(private readonly cause: unknown) {}

  public get(): Promise<string | null> {
    return Promise.resolve(null);
  }

  public set(): Promise<void> {
    return Promise.reject(
      new KeychainUnavailableError('Keychain is unavailable for set operation.', {
        operation: 'set',
        cause: this.cause,
      }),
    );
  }

  public delete(): Promise<boolean> {
    return Promise.reject(
      new KeychainUnavailableError('Keychain is unavailable for delete operation.', {
        operation: 'delete',
        cause: this.cause,
      }),
    );
  }

  public list(): Promise<readonly { account: string }[]> {
    return Promise.resolve([]);
  }

  public isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/**
 * Creates a keychain provider backed by keytar when available.
 *
 * @param loader Optional dependency loader for tests.
 */
export async function createKeychainProvider(
  loader: () => Promise<unknown> = () => import('keytar'),
): Promise<KeychainProvider> {
  try {
    const loaded = await loader();
    const candidate = ((loaded as { default?: unknown }).default ??
      loaded) as Partial<KeytarModule>;

    if (
      typeof candidate.getPassword !== 'function' ||
      typeof candidate.setPassword !== 'function' ||
      typeof candidate.deletePassword !== 'function' ||
      typeof candidate.findCredentials !== 'function'
    ) {
      throw new Error('Loaded keytar module is missing required methods.');
    }

    return new KeytarProvider(candidate as KeytarModule);
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      logger.warn(
        {
          reason: error instanceof Error ? error.message : String(error),
        },
        'OS keychain unavailable; falling back to degraded secret provider',
      );
    }
    return new UnavailableKeychainProvider(error);
  }
}
