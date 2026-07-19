import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import type { BrowserProvider, Logger } from '../../browser/types.js';
import { YANTRA_KEYCHAIN_SERVICE, type KeychainProvider } from '../../secrets/keychain.js';
import type { SearchProviderName, SearchResult } from '../types.js';

import { BraveSearchProvider } from './brave.js';
import { DuckDuckGoSearchProvider } from './duckduckgo.js';
import {
  NoSearchProviderAvailableError,
  SearchProviderKeyMissingError,
  UnknownSearchProviderError,
} from './errors.js';
import type { SearchProviderError } from './errors.js';
import { GoogleSearchProvider } from './google.js';
import { ScrapeTransport, type SearchEthicsGate } from './scrape-transport.js';
import { TavilySearchProvider } from './tavily.js';

/**
 * The runtime contract every search provider implements. Kept intentionally
 * small — a name plus a bounded, cancelable search — so provider internals port
 * over unchanged and a future provider is one descriptor file.
 */
export interface SearchProvider {
  readonly name: SearchProviderName;
  search(
    query: string,
    opts: { limit: number; signal: AbortSignal },
  ): Promise<readonly SearchResult[]>;
}

/** A provider name, or `auto` (walk the fallback chain). */
export type SearchProviderSelection = SearchProviderName | 'auto';

/**
 * Runtime dependencies handed to a descriptor's `create` factory. API providers
 * use `keychain`; scraped providers compose the {@link ScrapeTransport} from
 * `browserProvider` + `ethicsGate` + `logger`.
 */
export interface SearchProviderDeps {
  readonly keychain: KeychainProvider;
  readonly browserProvider: BrowserProvider;
  readonly ethicsGate: SearchEthicsGate;
  readonly logger: Logger;
  /** Keychain service name; defaults to `yantra`. */
  readonly keychainService?: string;
}

/**
 * A registry entry describing one search provider. Adding a future provider
 * (e.g. `exa`) is a single new descriptor file plus its registration here —
 * mirroring the step-verb and locator-kind registries.
 */
export interface SearchProviderDescriptor {
  /** Registry key. Unique. */
  readonly name: SearchProviderName;
  /** Keychain account the provider needs, or `null` for key-free scraping. */
  readonly requiresKey: string | null;
  /** `scrape` providers require the ethics gate + browser transport. */
  readonly kind: 'api' | 'scrape';
  /** Factory producing a live {@link SearchProvider} from runtime deps. */
  create(deps: SearchProviderDeps): SearchProvider;
}

function scrapeTransport(deps: SearchProviderDeps): ScrapeTransport {
  return new ScrapeTransport({
    browserProvider: deps.browserProvider,
    ethicsGate: deps.ethicsGate,
    logger: deps.logger,
  });
}

/**
 * The search provider registry. One entry per provider, keyed by name.
 *
 * ### Adding a provider
 * 1. Create `search/<name>.ts` exporting a class that implements
 *    {@link SearchProvider}.
 * 2. Add a {@link SearchProviderDescriptor} here (name, `requiresKey`, `kind`,
 *    `create`).
 * 3. Add recorded fixtures under `tests/extraction/search/fixtures/` and let the
 *    contract suite (`contract.spec.ts`) exercise it automatically.
 */
export const SEARCH_PROVIDER_REGISTRY = {
  google: {
    name: 'google',
    requiresKey: null,
    kind: 'scrape',
    create: (deps) => new GoogleSearchProvider({ transport: scrapeTransport(deps) }),
  },
  duckduckgo: {
    name: 'duckduckgo',
    requiresKey: null,
    kind: 'scrape',
    create: (deps) => new DuckDuckGoSearchProvider({ transport: scrapeTransport(deps) }),
  },
  brave: {
    name: 'brave',
    requiresKey: 'brave.api_key',
    kind: 'api',
    create: (deps) =>
      new BraveSearchProvider({
        keychain: deps.keychain,
        ...(deps.keychainService ? { keychainService: deps.keychainService } : {}),
      }),
  },
  tavily: {
    name: 'tavily',
    requiresKey: 'tavily.api_key',
    kind: 'api',
    create: (deps) =>
      new TavilySearchProvider({
        keychain: deps.keychain,
        ...(deps.keychainService ? { keychainService: deps.keychainService } : {}),
      }),
  },
} as const satisfies Record<SearchProviderName, SearchProviderDescriptor>;

/** All registered provider names, in registry declaration order. */
export const SEARCH_PROVIDER_NAMES = Object.keys(
  SEARCH_PROVIDER_REGISTRY,
) as readonly SearchProviderName[];

/** Configuration for search provider resolution (from `config.yaml`). */
export interface SearchConfig {
  /** Preferred provider, or `auto` to walk the fallback chain. */
  readonly provider: SearchProviderSelection;
  /** Order `auto` walks, skipping key-missing API providers. */
  readonly fallbackChain: readonly SearchProviderName[];
  /**
   * How many of the top search hits the combined `web_search` tool fetches and
   * extracts inline (the rest are returned as snippet-only "more results"). A
   * small bound keeps one combined result from evicting a local model's
   * context; the hard ceiling is enforced separately in the agent tool.
   */
  readonly fetchTop: number;
}

/**
 * Default search config. `auto` prefers the keyed API providers, then falls to
 * key-free DuckDuckGo, which always resolves. Google is deliberately absent —
 * highest anti-bot friction, opt-in only (honesty over cleverness).
 */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'auto',
  fallbackChain: ['tavily', 'brave', 'duckduckgo'],
  fetchTop: 3,
};

export interface ResolveSearchProviderOptions {
  /**
   * Explicit selection from a CLI flag (highest precedence). A concrete name
   * fails hard if its key is missing; `auto`/`null`/`undefined` fall through to
   * env → config → auto.
   */
  readonly explicitProvider?: SearchProviderSelection | null;
  /** Process env; `SEARCH_PROVIDER` is read as the second precedence source. */
  readonly env?: NodeJS.ProcessEnv;
  /** Loaded search config; defaults to {@link DEFAULT_SEARCH_CONFIG}. */
  readonly config?: SearchConfig;
  /** Runtime deps passed to the chosen descriptor's factory. */
  readonly deps: SearchProviderDeps;
}

/** Where a resolved provider selection came from — logged for observability. */
type ResolutionVia = 'flag' | 'env' | 'config' | 'auto';

/**
 * Resolves a concrete {@link SearchProvider} from the registry using the
 * precedence **explicit flag > `SEARCH_PROVIDER` env > `config.search.provider`
 * > `auto`**.
 *
 * - **Explicit** selection (flag/env/config naming a concrete provider) fails
 *   hard with {@link SearchProviderKeyMissingError} when its API key is absent —
 *   misconfiguration is surfaced, not silently downgraded.
 * - **`auto`** walks `config.fallbackChain`, skipping API providers whose keys
 *   are missing. Key-free scraped providers always resolve, so a chain ending in
 *   `duckduckgo` never fails; an all-API chain with no keys yields
 *   {@link NoSearchProviderAvailableError}.
 *
 * @returns `ok(provider)` on success, or `err(SearchProviderError)` describing
 *   what to configure.
 */
export async function resolveSearchProvider(
  options: ResolveSearchProviderOptions,
): Promise<Result<SearchProvider, SearchProviderError>> {
  const config = options.config ?? DEFAULT_SEARCH_CONFIG;
  const deps = options.deps;
  const logger = deps.logger;

  const flag = concreteSelection(options.explicitProvider);
  const envSel = concreteSelection(parseProviderFromEnv(options.env?.SEARCH_PROVIDER));
  const configSel = concreteSelection(config.provider);

  const explicit: { name: SearchProviderName; via: ResolutionVia } | null = flag
    ? { name: flag, via: 'flag' }
    : envSel
      ? { name: envSel, via: 'env' }
      : configSel
        ? { name: configSel, via: 'config' }
        : null;

  if (explicit) {
    return resolveExplicit(explicit.name, explicit.via, deps, logger);
  }

  return resolveAuto(config.fallbackChain, deps, logger);
}

/** Resolves an explicitly named provider, failing hard on a missing key. */
async function resolveExplicit(
  name: SearchProviderName,
  via: ResolutionVia,
  deps: SearchProviderDeps,
  logger: Logger,
): Promise<Result<SearchProvider, SearchProviderError>> {
  const descriptor = SEARCH_PROVIDER_REGISTRY[name];
  if (!descriptor) {
    return err(new UnknownSearchProviderError(name));
  }

  if (descriptor.requiresKey) {
    const present = await hasKey(deps, descriptor.requiresKey);
    if (!present) {
      return err(new SearchProviderKeyMissingError(name, descriptor.requiresKey));
    }
  }

  logger.info({ provider: name, via }, 'selected search provider');
  return ok(descriptor.create(deps));
}

/** Walks the fallback chain, skipping key-missing API providers. */
async function resolveAuto(
  chain: readonly SearchProviderName[],
  deps: SearchProviderDeps,
  logger: Logger,
): Promise<Result<SearchProvider, SearchProviderError>> {
  for (const name of chain) {
    const descriptor = SEARCH_PROVIDER_REGISTRY[name];
    if (!descriptor) {
      continue;
    }

    if (descriptor.requiresKey === null) {
      logger.info({ provider: name, via: 'auto' }, 'selected search provider');
      return ok(descriptor.create(deps));
    }

    if (await hasKey(deps, descriptor.requiresKey)) {
      logger.info({ provider: name, via: 'auto' }, 'selected search provider');
      return ok(descriptor.create(deps));
    }
  }

  return err(new NoSearchProviderAvailableError(chain));
}

/** Narrows a selection to a concrete provider name, or `null` for `auto`/unset. */
function concreteSelection(
  selection: SearchProviderSelection | null | undefined,
): SearchProviderName | null {
  return selection && selection !== 'auto' ? selection : null;
}

/** Parses `SEARCH_PROVIDER`, tolerating case/whitespace; unknown → `null`. */
export function parseProviderFromEnv(raw: string | undefined): SearchProviderSelection | null {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === 'auto' || value in SEARCH_PROVIDER_REGISTRY) {
    return value as SearchProviderSelection;
  }
  return null;
}

async function hasKey(deps: SearchProviderDeps, account: string): Promise<boolean> {
  const value = await deps.keychain.get(deps.keychainService ?? YANTRA_KEYCHAIN_SERVICE, account);
  return typeof value === 'string' && value.length > 0;
}
