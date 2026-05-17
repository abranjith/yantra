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
 */
export async function selectSearchProvider(
  options: SelectSearchProviderOptions,
): Promise<SearchProvider> {
  const configured =
    options.explicitProvider ??
    parseProviderFromEnv(process.env.SEARCH_PROVIDER) ??
    options.config?.search?.provider ??
    'auto';

  const hasTavily = await hasKey(options.keychain, 'tavily.api_key');
  const hasBrave = await hasKey(options.keychain, 'brave.api_key');

  if (configured === 'tavily') {
    if (hasTavily) {
      options.logger.info({ provider: 'tavily' }, 'selected search provider');
      return new TavilySearchProvider({ keychain: options.keychain });
    }
    options.logger.warn('tavily requested but key missing; falling back');
  }

  if (configured === 'brave') {
    if (hasBrave) {
      options.logger.info({ provider: 'brave' }, 'selected search provider');
      return new BraveSearchProvider({ keychain: options.keychain });
    }
    options.logger.warn('brave requested but key missing; falling back');
  }

  if (configured === 'auto') {
    if (hasTavily) {
      options.logger.info({ provider: 'tavily' }, 'selected search provider');
      return new TavilySearchProvider({ keychain: options.keychain });
    }
    if (hasBrave) {
      options.logger.info({ provider: 'brave' }, 'selected search provider');
      return new BraveSearchProvider({ keychain: options.keychain });
    }
  }

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
