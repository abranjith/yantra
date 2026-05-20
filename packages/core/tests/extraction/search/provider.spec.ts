import { describe, expect, it } from 'vitest';

import type {
  BrowserProvider,
  BrowserSession,
  ChromeInstall,
  Page,
} from '../../../src/browser/types.js';
import { selectSearchProvider } from '../../../src/extraction/search/provider.js';
import type { KeychainProvider } from '../../../src/secrets/keychain.js';

class StubPage implements Page {
  public async goto(): Promise<unknown> {
    return null;
  }
  public async evaluate<T>(): Promise<T> {
    return [] as T;
  }
  public async close(): Promise<void> {
    return;
  }
  public url(): string {
    return 'https://example.com';
  }
  public on(): void {
    return;
  }
}

class StubSession implements BrowserSession {
  public readonly id = 'stub';
  public readonly chrome: ChromeInstall = {
    path: '/fake/chrome',
    version: '124.0.0.0',
    majorVersion: 124,
    channel: 'stable',
    source: 'system',
  };
  public readonly profilePath = '/tmp/stub';
  public async newPage(): Promise<Page> {
    return new StubPage();
  }
  public async close(): Promise<void> {
    return;
  }
  public on(): void {
    return;
  }
}

function browserProvider(): BrowserProvider {
  return {
    launch: async () => new StubSession(),
    detectChrome: async () => null,
  };
}

function keychain(entries: Record<string, string>): KeychainProvider {
  return {
    get: async (_service, account) => entries[account] ?? null,
    set: async () => undefined,
    delete: async () => false,
    list: async () => [],
    isAvailable: async () => true,
  };
}

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('@no-llm extraction/search/provider-selector', () => {
  it('selects tavily when explicitly requested and key exists', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'tavily',
      keychain: keychain({ 'tavily.api_key': 'k' }),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('tavily');
  });

  it('falls back to browser when explicit tavily key is missing', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'tavily',
      keychain: keychain({}),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('browser');
  });

  it('auto prefers tavily when API keys are present', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'auto',
      keychain: keychain({ 'tavily.api_key': 'a', 'brave.api_key': 'b' }),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('tavily');
  });

  it('auto uses brave when tavily key is missing', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'auto',
      keychain: keychain({ 'brave.api_key': 'b' }),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('brave');
  });

  it('auto uses browser when no keys are available', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'auto',
      keychain: keychain({}),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('browser');
  });

  it('selects brave when explicitly requested and key exists', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'brave',
      keychain: keychain({ 'brave.api_key': 'k' }),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('brave');
  });

  it('falls back to browser when explicit brave key is missing', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'brave',
      keychain: keychain({}),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('browser');
  });

  it('browser provider selected explicitly', async () => {
    const selected = await selectSearchProvider({
      explicitProvider: 'browser',
      keychain: keychain({ 'tavily.api_key': 'a', 'brave.api_key': 'b' }),
      browserProvider: browserProvider(),
      ethicsGate: { checkUrl: async () => ({ ok: true }) },
      logger,
    });

    expect(selected.name).toBe('browser');
  });
});
