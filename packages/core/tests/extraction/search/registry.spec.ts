import { describe, expect, it, vi } from 'vitest';

import {
  NoSearchProviderAvailableError,
  SearchProviderKeyMissingError,
} from '../../../src/extraction/search/errors.js';
import {
  DEFAULT_SEARCH_CONFIG,
  planSearchProvider,
  resolveSearchProvider,
  searchKeyProbe,
  type SearchConfig,
  type SearchProviderDeps,
} from '../../../src/extraction/search/registry.js';

import { fakeBrowserProvider, keychainWith, passGate, silentLogger } from './helpers.js';

function deps(entries: Record<string, string> = {}): SearchProviderDeps {
  return {
    keychain: keychainWith(entries),
    pages: fakeBrowserProvider('<html></html>').pages,
    ethicsGate: passGate,
    logger: silentLogger,
  };
}

describe('@no-llm extraction/search/resolveSearchProvider', () => {
  it('resolves an explicitly requested api provider when its key is present', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: 'tavily',
      deps: deps({ 'tavily.api_key': 'k' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('tavily');
    }
  });

  it('fails hard with a keyed hint when an explicit api provider key is missing', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: 'tavily',
      deps: deps({}),
    });

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toBeInstanceOf(SearchProviderKeyMissingError);
      expect(result.error.message).toContain('yantra init');
      expect(result.error.message).toContain('tavily.api_key');
    }
  });

  it('resolves an explicit scrape provider without any key', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: 'duckduckgo',
      deps: deps({}),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('duckduckgo');
    }
  });

  it('auto walks the full default chain and prefers tavily when its key is present', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: null,
      deps: deps({ 'tavily.api_key': 'a', 'brave.api_key': 'b' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('tavily');
    }
  });

  it('auto skips key-missing api providers and lands on brave', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: null,
      deps: deps({ 'brave.api_key': 'b' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('brave');
    }
  });

  it('auto with no keys resolves the chain-terminal duckduckgo (never fails)', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: null,
      deps: deps({}),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('duckduckgo');
    }
  });

  it('auto over an all-api chain with no keys yields NoSearchProviderAvailableError', async () => {
    const config: SearchConfig = { provider: 'auto', fallbackChain: ['tavily', 'brave'] };
    const result = await resolveSearchProvider({
      explicitProvider: null,
      config,
      deps: deps({}),
    });

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toBeInstanceOf(NoSearchProviderAvailableError);
      expect(result.error.message).toContain('duckduckgo');
    }
  });

  it('auto over an empty chain yields NoSearchProviderAvailableError', async () => {
    const config: SearchConfig = { provider: 'auto', fallbackChain: [] };
    const result = await resolveSearchProvider({
      explicitProvider: null,
      config,
      deps: deps({ 'tavily.api_key': 'k' }),
    });

    expect(result.isOk).toBe(false);
    if (!result.isOk) {
      expect(result.error).toBeInstanceOf(NoSearchProviderAvailableError);
    }
  });

  it('honors SEARCH_PROVIDER env over config when no flag is given', async () => {
    const config: SearchConfig = { provider: 'tavily', fallbackChain: ['tavily', 'duckduckgo'] };
    const result = await resolveSearchProvider({
      explicitProvider: null,
      env: { SEARCH_PROVIDER: 'brave' },
      config,
      deps: deps({ 'brave.api_key': 'b', 'tavily.api_key': 't' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('brave');
    }
  });

  it('honors config.provider over auto when no flag or env is given', async () => {
    const config: SearchConfig = { provider: 'brave', fallbackChain: ['tavily', 'duckduckgo'] };
    const result = await resolveSearchProvider({
      explicitProvider: null,
      config,
      deps: deps({ 'brave.api_key': 'b' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('brave');
    }
  });

  it('lets an explicit flag override env and config', async () => {
    const config: SearchConfig = {
      provider: 'brave',
      fallbackChain: DEFAULT_SEARCH_CONFIG.fallbackChain,
    };
    const result = await resolveSearchProvider({
      explicitProvider: 'duckduckgo',
      env: { SEARCH_PROVIDER: 'tavily' },
      config,
      deps: deps({ 'tavily.api_key': 't', 'brave.api_key': 'b' }),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      expect(result.value.name).toBe('duckduckgo');
    }
  });

  it('treats an explicit "auto" selection as falling through to env/config/auto', async () => {
    const result = await resolveSearchProvider({
      explicitProvider: 'auto',
      deps: deps({}),
    });

    expect(result.isOk).toBe(true);
    if (result.isOk) {
      // No keys, default chain → duckduckgo.
      expect(result.value.name).toBe('duckduckgo');
    }
  });
});

describe('@no-llm extraction/search/planSearchProvider (FEAT-050)', () => {
  interface Case {
    readonly name: string;
    readonly explicitProvider?: 'tavily' | 'brave' | 'duckduckgo' | 'google' | 'auto' | null;
    readonly env?: NodeJS.ProcessEnv;
    readonly config?: SearchConfig;
    readonly keys: Record<string, string>;
  }
  const CASES: readonly Case[] = [
    {
      name: 'explicit keyed, key present',
      explicitProvider: 'tavily',
      keys: { 'tavily.api_key': 'k' },
    },
    { name: 'explicit keyed, key missing', explicitProvider: 'brave', keys: {} },
    { name: 'explicit scrape', explicitProvider: 'duckduckgo', keys: {} },
    {
      name: 'explicit auto falls through',
      explicitProvider: 'auto',
      keys: { 'brave.api_key': 'k' },
    },
    { name: 'auto prefers tavily', keys: { 'tavily.api_key': 'k', 'brave.api_key': 'k' } },
    { name: 'auto skips to brave', keys: { 'brave.api_key': 'k' } },
    { name: 'auto lands on duckduckgo', keys: {} },
    {
      name: 'auto all-api chain, no keys',
      config: { ...DEFAULT_SEARCH_CONFIG, fallbackChain: ['tavily', 'brave'] },
      keys: {},
    },
    { name: 'auto empty chain', config: { ...DEFAULT_SEARCH_CONFIG, fallbackChain: [] }, keys: {} },
    { name: 'env over config', env: { SEARCH_PROVIDER: 'google' }, keys: {} },
    {
      name: 'config over auto',
      config: { ...DEFAULT_SEARCH_CONFIG, provider: 'duckduckgo' },
      keys: { 'tavily.api_key': 'k' },
    },
    {
      name: 'flag over env and config',
      explicitProvider: 'duckduckgo',
      env: { SEARCH_PROVIDER: 'google' },
      config: { ...DEFAULT_SEARCH_CONFIG, provider: 'brave' },
      keys: {},
    },
  ];

  it.each(CASES)('agrees with resolveSearchProvider: $name', async (testCase) => {
    const selection = {
      ...(testCase.explicitProvider === undefined
        ? {}
        : { explicitProvider: testCase.explicitProvider }),
      env: testCase.env ?? {},
      ...(testCase.config === undefined ? {} : { config: testCase.config }),
    };
    const keychain = keychainWith(testCase.keys);

    const plan = await planSearchProvider({ ...selection, hasKey: searchKeyProbe(keychain) });
    const resolved = await resolveSearchProvider({
      ...selection,
      deps: { ...deps(testCase.keys), keychain },
    });

    if (plan instanceof Error) {
      expect(resolved.isOk).toBe(false);
      if (!resolved.isOk) expect(resolved.error.constructor).toBe(plan.constructor);
    } else {
      expect(resolved.isOk && resolved.value.name).toBe(plan.name);
    }
  });

  it('reports the kind and where the selection came from', async () => {
    expect(await planSearchProvider({ env: {}, hasKey: () => Promise.resolve(false) })).toEqual({
      name: 'duckduckgo',
      kind: 'scrape',
      via: 'auto',
    });
    expect(
      await planSearchProvider({
        env: { SEARCH_PROVIDER: 'tavily' },
        hasKey: () => Promise.resolve(true),
      }),
    ).toEqual({ name: 'tavily', kind: 'api', via: 'env' });
  });

  it('plans without creating a provider or logging a selection', async () => {
    const info = vi.fn();

    await planSearchProvider({ env: {}, hasKey: () => Promise.resolve(false) });
    await resolveSearchProvider({
      env: {},
      deps: { ...deps(), logger: { ...silentLogger, info } },
    });

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { provider: 'duckduckgo', via: 'auto' },
      'selected search provider',
    );
  });
});
