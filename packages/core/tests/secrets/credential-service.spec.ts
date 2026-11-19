import { describe, expect, it, vi } from 'vitest';

import { createCredentialService } from '../../src/secrets/credential-service.js';
import { KeychainUnavailableError } from '../../src/secrets/errors.js';

function fixture(available = true) {
  const values = new Map<string, string>();
  const logs: string[] = [];
  const keychain = {
    get: vi.fn(async () => null),
    set: vi.fn(async (_service: string, key: string, value: string) => {
      values.set(key, value);
    }),
    delete: vi.fn(async (_service: string, key: string) => values.delete(key)),
    list: vi.fn(async () => [...values.keys()].map((account) => ({ account }))),
    isAvailable: vi.fn(async () => available),
  };
  const service = createCredentialService({
    keychain,
    env: { PRESENT: 'CANARY-env' },
    logLevel: 'debug',
    logDestination: {
      write: (line) => {
        logs.push(line);
      },
    },
    loadConfig: async () =>
      ({
        isOk: true,
        value: {
          paths: { data_dir: null, cache_dir: null },
          search: {
            tavily: { api_key: { kind: 'secret', key: 'shared' } },
            brave: { api_key: { kind: 'env', name: 'MISSING' } },
          },
          models: [
            { provider: 'anthropic', id: 'a', api_key: { kind: 'secret', key: 'shared' } },
            { provider: 'ollama', id: 'b', api_key: { kind: 'env', name: 'PRESENT' } },
          ],
        },
      }) as Awaited<
        ReturnType<NonNullable<Parameters<typeof createCredentialService>[0]['loadConfig']>>
      >,
  });
  return { service, keychain, logs };
}

describe('@no-llm credential service', () => {
  it('merges sorted account and reference rows without reading values', async () => {
    const { service, keychain, logs } = fixture();
    const value = 'CANARY-store';
    await expect(service.setCredential({ key: 'shared', value })).resolves.toEqual({
      status: 'set',
      key: 'shared',
    });
    const result = await service.listCredentials();
    expect(result.rows.map(({ key, source }) => [key, source])).toEqual([
      ['brave.api_key', 'absent'],
      ['ollama/b', 'env'],
      ['shared', 'keychain'],
    ]);
    expect(result.rows[2]?.referenced_by).toEqual([
      { kind: 'search', id: 'tavily', ref: { kind: 'secret', key: 'shared' } },
      { kind: 'model', id: 'anthropic/a', ref: { kind: 'secret', key: 'shared' } },
    ]);
    expect(keychain.get).not.toHaveBeenCalled();
    await expect(service.removeCredential({ key: 'shared' })).resolves.toMatchObject({
      status: 'removed',
    });
    await expect(service.removeCredential({ key: 'shared' })).resolves.toMatchObject({
      status: 'absent',
    });
    expect(logs.join('')).toContain('shared');
    expect(JSON.stringify({ result, logs })).not.toContain('CANARY-');
  });

  it('validates keys and counts UTF-8 bytes before storage', async () => {
    const { service, keychain } = fixture();
    await expect(service.setCredential({ key: 'Invalid', value: 'ok' })).rejects.toMatchObject({
      name: 'CredentialKeyInvalidError',
    });
    await expect(service.setCredential({ key: 'valid', value: '' })).rejects.toMatchObject({
      name: 'CredentialValueInvalidError',
    });
    await expect(
      service.setCredential({ key: 'valid', value: 'é'.repeat(4096) + 'x' }),
    ).rejects.toMatchObject({ name: 'CredentialValueInvalidError' });
    expect(keychain.set).not.toHaveBeenCalled();
    await expect(
      service.setCredential({ key: 'valid', value: 'é'.repeat(4096) }),
    ).resolves.toMatchObject({ status: 'set' });
  });

  it('returns a remedy if unavailable and does not echo native errors', async () => {
    const offline = fixture(false);
    await expect(offline.service.listCredentials()).resolves.toMatchObject({
      available: false,
      remedy: expect.stringContaining('${env:NAME}'),
    });
    await expect(offline.service.removeCredential({ key: 'valid' })).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
    const { keychain, service, logs } = fixture();
    keychain.set.mockRejectedValueOnce(new Error('CANARY-native'));
    await expect(service.setCredential({ key: 'valid', value: 'CANARY-native' })).rejects.toThrow(
      'OS keychain unavailable',
    );
    await expect(Promise.resolve(logs.join(''))).resolves.not.toContain('CANARY-native');
  });
});
