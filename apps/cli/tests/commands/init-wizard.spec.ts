import type { KeychainProvider } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { runInitWizard } from '../../src/commands/init-wizard.js';

describe('@no-llm init wizard', () => {
  it('collects provider, env reference, model, and storage in order', async () => {
    const selections = ['anthropic', 'environment variable'];
    const texts = ['ANTHROPIC_API_KEY', 'claude-custom', 'D:\\yantra-data'];
    const result = await runInitWizard({
      select: async () => selections.shift() ?? null,
      text: async () => texts.shift() ?? null,
    });
    expect(result).toEqual({
      provider: 'anthropic',
      modelId: 'claude-custom',
      baseUrl: null,
      apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
      dataDir: 'D:\\yantra-data',
      searchKey: { status: 'skipped' },
    });
  });

  it('skips credential prompts for provider none', async () => {
    const password = vi.fn(async () => 'unused');
    const result = await runInitWizard({
      select: async () => 'none',
      text: async () => '',
      password,
    });
    expect(result.provider).toBe('none');
    expect(result.apiKey).toBeNull();
    expect(password).not.toHaveBeenCalled();
  });

  describe('search provider key step (FEAT-050)', () => {
    function memoryKeychain(available = true): KeychainProvider & {
      readonly stored: Map<string, string>;
    } {
      const stored = new Map<string, string>();
      return {
        stored,
        get: async (_service, account) => stored.get(account) ?? null,
        set: async (service, account, value) => {
          stored.set(account, `${service}:${value}`);
        },
        delete: async () => false,
        list: async () => [],
        isAvailable: async () => available,
      };
    }

    /** Provider none, then the search-key choice, then storage. */
    function wizardFor(searchChoice: string, keychain: () => Promise<KeychainProvider>) {
      const selections = ['none', searchChoice];
      return runInitWizard({
        select: async () => selections.shift() ?? null,
        text: async () => '',
        password: async () => 'search-secret',
        keychain,
      });
    }

    it('offers the step with tavily, brave, and skip', async () => {
      const choices: (readonly string[])[] = [];
      await runInitWizard({
        select: async (message, offered) => {
          if (message === 'Search provider key (optional)') choices.push(offered);
          return message === 'Model provider' ? 'none' : 'skip';
        },
        text: async () => '',
      });
      expect(choices).toEqual([['tavily', 'brave', 'skip']]);
    });

    it('skip writes nothing', async () => {
      const keychain = memoryKeychain();
      const result = await wizardFor('skip', async () => keychain);
      expect(result.searchKey).toEqual({ status: 'skipped' });
      expect(keychain.stored.size).toBe(0);
    });

    it('stores a chosen tavily key under tavily.api_key in the yantra service', async () => {
      const keychain = memoryKeychain();
      const result = await wizardFor('tavily', async () => keychain);
      expect(result.searchKey).toEqual({ status: 'stored', provider: 'tavily' });
      expect(keychain.stored.get('tavily.api_key')).toBe('yantra:search-secret');
    });

    it('asks after the model step on an LLM provider path', async () => {
      const selections = ['ollama', 'skip', 'brave'];
      const keychain = memoryKeychain();
      const result = await runInitWizard({
        select: async () => selections.shift() ?? null,
        text: async () => '',
        password: async () => 'b-secret',
        keychain: async () => keychain,
      });
      expect(result.modelId).toBe('llama3.1:8b');
      expect(result.searchKey).toEqual({ status: 'stored', provider: 'brave' });
    });

    it('returns the secret-set command instead of failing when the keychain is unavailable', async () => {
      const unavailable = await wizardFor('tavily', async () => memoryKeychain(false));
      const throwing = await wizardFor('brave', () => Promise.reject(new Error('no keychain')));
      expect(unavailable.searchKey).toEqual({
        status: 'manual',
        provider: 'tavily',
        command: 'yantra secret set tavily.api_key',
      });
      expect(throwing.searchKey).toMatchObject({ status: 'manual', provider: 'brave' });
    });

    it('treats an empty secret as skip', async () => {
      const keychain = memoryKeychain();
      const selections = ['none', 'tavily'];
      const result = await runInitWizard({
        select: async () => selections.shift() ?? null,
        text: async () => '',
        password: async () => '',
        keychain: async () => keychain,
      });
      expect(result.searchKey).toEqual({ status: 'skipped' });
      expect(keychain.stored.size).toBe(0);
    });
  });
});
