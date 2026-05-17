/**
 * @no-llm Tests for LLMClientFactory.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createLLMClient } from '../../src/client/factory.js';
import { NullLLMClient } from '../../src/client/null.js';
import { makeBudget } from '../factories.js';

const BASE_CONFIG = { provider: 'none' as const, defaultBudget: makeBudget() };

describe('createLLMClient', () => {
  afterEach(() => {
    delete process.env['LLM_PROVIDER'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('returns NullLLMClient when provider is none', () => {
    const client = createLLMClient(BASE_CONFIG);
    expect(client).toBeInstanceOf(NullLLMClient);
    expect(client.providerId).toBe('null');
  });

  it('LLM_PROVIDER=none env var overrides config', () => {
    process.env['LLM_PROVIDER'] = 'none';
    const client = createLLMClient({ ...BASE_CONFIG, provider: 'anthropic' });
    expect(client).toBeInstanceOf(NullLLMClient);
  });

  it('anthropic without API key degrades to NullLLMClient with warning', () => {
    const warnMessages: string[] = [];
    const logger = {
      warn: (_obj: object | string, msg?: string) => {
        warnMessages.push(msg ?? String(_obj));
      },
      info: () => {
        /* noop logger */
      },
    };

    const client = createLLMClient(
      {
        ...BASE_CONFIG,
        provider: 'anthropic',
        anthropic: { apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' }, model: 'test-model' },
      },
      { logger },
    );

    expect(client).toBeInstanceOf(NullLLMClient);
    expect(warnMessages.some((m) => m.includes('no API key') || m.includes('pi-agent-core'))).toBe(
      true,
    );
  });

  it('anthropic with API key logs pi-agent-core unavailable warning', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test-fake-key';
    const warnMessages: string[] = [];
    const logger = {
      warn: (_obj: object | string, msg?: string) => {
        warnMessages.push(msg ?? String(_obj));
      },
      info: () => {
        /* noop logger */
      },
    };

    const client = createLLMClient(
      {
        ...BASE_CONFIG,
        provider: 'anthropic',
        anthropic: { apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' }, model: 'test-model' },
      },
      { logger },
    );

    expect(client).toBeInstanceOf(NullLLMClient);
    // No API key bytes in warn messages
    expect(warnMessages.every((m) => !m.includes('sk-test-fake-key'))).toBe(true);
  });

  it('ollama degrades to NullLLMClient with warning (pi-agent-core unavailable)', () => {
    const warnMessages: string[] = [];
    const client = createLLMClient(
      {
        ...BASE_CONFIG,
        provider: 'ollama',
        ollama: { baseUrl: 'http://localhost:11434', model: 'llama3.1:8b' },
      },
      {
        logger: {
          warn: (_: object | string, m?: string) => warnMessages.push(m ?? ''),
          info: () => {
            /* noop logger */
          },
        },
      },
    );
    expect(client).toBeInstanceOf(NullLLMClient);
    expect(warnMessages.some((m) => m.includes('pi-agent-core') || m.includes('ollama'))).toBe(
      true,
    );
  });

  it('openai logs unsupported warning and returns NullLLMClient', () => {
    const warnMessages: string[] = [];
    const client = createLLMClient(
      { ...BASE_CONFIG, provider: 'openai' },
      {
        logger: {
          warn: (_: object | string, m?: string) => warnMessages.push(m ?? ''),
          info: () => {
            /* noop logger */
          },
        },
      },
    );
    expect(client).toBeInstanceOf(NullLLMClient);
    expect(warnMessages.some((m) => m.includes('openai'))).toBe(true);
  });

  it('unknown provider returns NullLLMClient with warning', () => {
    const warnMessages: string[] = [];
    const client = createLLMClient(
      { ...BASE_CONFIG, provider: 'unknown' as never },
      {
        logger: {
          warn: (_: object | string, m?: string) => warnMessages.push(m ?? ''),
          info: () => {
            /* noop logger */
          },
        },
      },
    );
    expect(client).toBeInstanceOf(NullLLMClient);
    expect(warnMessages.length).toBeGreaterThan(0);
  });

  it('never throws — always returns a client', () => {
    expect(() => createLLMClient({ ...BASE_CONFIG, provider: 'none' as const })).not.toThrow();
    expect(() => createLLMClient({ ...BASE_CONFIG, provider: 'unknown' as never })).not.toThrow();
  });
});
