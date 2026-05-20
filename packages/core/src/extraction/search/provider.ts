import type { BrowserProvider, Logger } from '../../browser/types.js';
import { type KeychainProvider } from '../../secrets/keychain.js';
import type { SearchProviderName, SearchResult } from '../types.js';

import { BraveSearchProvider } from './brave.js';
import { BrowserSearchProvider, type BrowserSearchEthicsGate } from './browser.js';
import { TavilySearchProvider } from './tavily.js';

export interface SearchProvider {
  readonly name: SearchProviderName;
  search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]>;
}

export type SearchProviderSelection = SearchProviderName | 'auto';

export interface SearchProviderConfig {
  readonly search?: {
    readonly provider?: SearchProviderSelection;
  };
}

export interface SelectSearchProviderOptions {
  readonly config?: SearchProviderConfig;
  readonly explicitProvider?: SearchProviderSelection;
  readonly keychain: KeychainProvider;
  readonly browserProvider: BrowserProvider;
  readonly ethicsGate: BrowserSearchEthicsGate;
  readonly logger: Logger;
}

/**
 * Selects a concrete SearchProvider using config, env override, and keychain.
 *
 * `auto` prefers API providers when keys are present (tavily, then brave), and
 * falls back to browser search when no API keys are available.
 * Explicit provider requests still require their matching API keys.
 */
export async function selectSearchProvider(
  options: SelectSearchProviderOptions,
): Promise<SearchProvider> {
  const configured =
    options.explicitProvider ??
    parseProviderFromEnv(process.env.SEARCH_PROVIDER) ??
    options.config?.search?.provider ??
    'auto';

  if (configured === 'auto') {
    if (await hasKey(options.keychain, 'tavily.api_key')) {
      options.logger.info({ provider: 'tavily' }, 'selected search provider');
      return new TavilySearchProvider({ keychain: options.keychain });
    }

    if (await hasKey(options.keychain, 'brave.api_key')) {
      options.logger.info({ provider: 'brave' }, 'selected search provider');
      return new BraveSearchProvider({ keychain: options.keychain });
    }

    options.logger.info({ provider: 'browser' }, 'selected search provider');
    return new BrowserSearchProvider({
      browserProvider: options.browserProvider,
      ethicsGate: options.ethicsGate,
      logger: options.logger,
    });
  }

  if (configured === 'tavily') {
    if (await hasKey(options.keychain, 'tavily.api_key')) {
      options.logger.info({ provider: 'tavily' }, 'selected search provider');
      return new TavilySearchProvider({ keychain: options.keychain });
    }
    options.logger.warn('tavily requested but key missing; falling back to browser');
  }

  if (configured === 'brave') {
    if (await hasKey(options.keychain, 'brave.api_key')) {
      options.logger.info({ provider: 'brave' }, 'selected search provider');
      return new BraveSearchProvider({ keychain: options.keychain });
    }
    options.logger.warn('brave requested but key missing; falling back to browser');
  }

  // Explicit browser selection always resolves to browser.
  options.logger.info({ provider: 'browser' }, 'selected search provider');
  return new BrowserSearchProvider({
    browserProvider: options.browserProvider,
    ethicsGate: options.ethicsGate,
    logger: options.logger,
  });
}

function parseProviderFromEnv(raw: string | undefined): SearchProviderSelection | null {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (value === 'auto' || value === 'tavily' || value === 'brave' || value === 'browser') {
    return value;
  }

  return null;
}

async function hasKey(keychain: KeychainProvider, account: string): Promise<boolean> {
  const value = await keychain.get('yantra', account);
  return typeof value === 'string' && value.length > 0;
}
