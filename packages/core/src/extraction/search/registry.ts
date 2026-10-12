import type { Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';

import type { PageSource } from '../../browser/page-source.js';
import type { Logger } from '../../browser/types.js';
import { YANTRA_KEYCHAIN_SERVICE, type KeychainProvider } from '../../secrets/keychain.js';
import type { SearchProviderName, SearchResult } from '../types.js';

import { BraveSearchProvider } from './brave.js';
import { resolveSearchCredential } from './credential.js';
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
 * `pages` + `ethicsGate` + `logger`.
 */
export interface SearchProviderDeps {
  readonly keychain: KeychainProvider;
  /** Where SERP renders get a page: the run's pool, or one launch per use. */
  readonly pages: PageSource;
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
    pages: deps.pages,
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
export type SearchResolutionVia = 'flag' | 'env' | 'config' | 'auto';

/** The provider a run would use, without building it. */
export interface SearchProviderPlan {
  readonly name: SearchProviderName;
  readonly kind: 'api' | 'scrape';
  readonly via: SearchResolutionVia;
}

/** Inputs to {@link planSearchProvider}: the selection sources and a key probe. */
export interface PlanSearchProviderOptions {
  /** Explicit selection from a CLI flag (highest precedence). */
  readonly explicitProvider?: SearchProviderSelection | null;
  /** Process env; `SEARCH_PROVIDER` is the second precedence source. */
  readonly env?: NodeJS.ProcessEnv;
  /** Loaded search config; defaults to {@link DEFAULT_SEARCH_CONFIG}. */
  readonly config?: SearchConfig;
  /** Whether the keychain (or env reference) holds a key for an account. */
  readonly hasKey: (account: string) => Promise<boolean>;
}

/**
 * The one selection grammar (FEAT-050): which provider a run would use, by
 * the precedence **explicit flag > `SEARCH_PROVIDER` env >
 * `config.search.provider` > `auto`**, without creating it.
 *
 * {@link resolveSearchProvider} plans and then creates; `yantra doctor` only
 * plans. One function owns "which provider?" so the two can never disagree
 * (memory → a grammar duplicated across layers is a silent divergence).
 *
 * - **Explicit** selection fails with {@link SearchProviderKeyMissingError}
 *   when its API key is absent — misconfiguration is surfaced, not downgraded.
 * - **`auto`** walks `config.fallbackChain`, skipping API providers whose keys
 *   are missing; an all-API chain with no keys yields
 *   {@link NoSearchProviderAvailableError}.
 *
 * @returns The plan, or the typed error describing what to configure.
 */
export async function planSearchProvider(
  options: PlanSearchProviderOptions,
): Promise<SearchProviderPlan | SearchProviderError> {
  const config = options.config ?? DEFAULT_SEARCH_CONFIG;
  const flag = concreteSelection(options.explicitProvider);
  const envSel = concreteSelection(parseProviderFromEnv(options.env?.SEARCH_PROVIDER));
  const configSel = concreteSelection(config.provider);

  const explicit: { name: SearchProviderName; via: SearchResolutionVia } | null = flag
    ? { name: flag, via: 'flag' }
    : envSel
      ? { name: envSel, via: 'env' }
      : configSel
        ? { name: configSel, via: 'config' }
        : null;

  if (explicit) {
    const descriptor = SEARCH_PROVIDER_REGISTRY[explicit.name];
    if (!descriptor) return new UnknownSearchProviderError(explicit.name);
    if (descriptor.requiresKey && !(await options.hasKey(descriptor.requiresKey))) {
      return new SearchProviderKeyMissingError(explicit.name, descriptor.requiresKey);
    }
    return { name: explicit.name, kind: descriptor.kind, via: explicit.via };
  }

  for (const name of config.fallbackChain) {
    const descriptor = SEARCH_PROVIDER_REGISTRY[name];
    if (!descriptor) continue;
    if (descriptor.requiresKey === null || (await options.hasKey(descriptor.requiresKey))) {
      return { name, kind: descriptor.kind, via: 'auto' };
    }
  }
  return new NoSearchProviderAvailableError(config.fallbackChain);
}

/**
 * Resolves a concrete {@link SearchProvider} from the registry: the
 * {@link planSearchProvider} selection, then the chosen descriptor's factory.
 * Logs "selected search provider" once per successful resolution — a run
 * resolves through its one `SearchService`, so once per run.
 *
 * @returns `ok(provider)` on success, or `err(SearchProviderError)` describing
 *   what to configure.
 */
export async function resolveSearchProvider(
  options: ResolveSearchProviderOptions,
): Promise<Result<SearchProvider, SearchProviderError>> {
  const deps = options.deps;
  const plan = await planSearchProvider({
    ...(options.explicitProvider === undefined
      ? {}
      : { explicitProvider: options.explicitProvider }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.config === undefined ? {} : { config: options.config }),
    hasKey: (account) => hasKey(deps, account),
  });
  if (plan instanceof Error) return err(plan);
  deps.logger.info({ provider: plan.name, via: plan.via }, 'selected search provider');
  return ok(SEARCH_PROVIDER_REGISTRY[plan.name].create(deps));
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

/**
 * Whether a search provider's key is available, exactly as a run checks it:
 * a configured `search.<provider>.api_key` reference (keychain or `${env:…}`)
 * first, then the keychain account itself. `yantra doctor` and
 * {@link resolveSearchProvider} share this probe so they cannot disagree.
 *
 * @param keychain The OS keychain provider.
 * @param options Keychain service (default `yantra`) and the env references read.
 */
export function searchKeyProbe(
  keychain: KeychainProvider,
  options: { readonly keychainService?: string; readonly env?: NodeJS.ProcessEnv } = {},
): (account: string) => Promise<boolean> {
  const service = options.keychainService ?? YANTRA_KEYCHAIN_SERVICE;
  return async (account) => {
    const provider = account.startsWith('tavily.')
      ? 'tavily'
      : account.startsWith('brave.')
        ? 'brave'
        : null;
    if (provider) {
      return (await resolveSearchCredential(provider, keychain, service, options.env)) !== null;
    }
    const value = await keychain.get(service, account);
    return typeof value === 'string' && value.length > 0;
  };
}

function hasKey(deps: SearchProviderDeps, account: string): Promise<boolean> {
  return searchKeyProbe(deps.keychain, {
    ...(deps.keychainService === undefined ? {} : { keychainService: deps.keychainService }),
  })(account);
}
