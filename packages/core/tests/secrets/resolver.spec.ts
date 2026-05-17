import type { ValueRef } from '@yantra/protocol';
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import type { SecretsJsonlEntry } from '../../src/audit/log-writer.js';
import { SecretNotFoundError } from '../../src/secrets/errors.js';
import { DefaultOpaqueRefResolver } from '../../src/secrets/resolver.js';

const keychainStore = new Map<string, string>();

const keychain = {
  get: async (service: string, account: string) =>
    keychainStore.get(`${service}:${account}`) ?? null,
  set: async (service: string, account: string, value: string) => {
    keychainStore.set(`${service}:${account}`, value);
  },
  delete: async (service: string, account: string) => keychainStore.delete(`${service}:${account}`),
  list: async (service: string) =>
    [...keychainStore.keys()]
      .filter((entry) => entry.startsWith(`${service}:`))
      .map((entry) => ({ account: entry.slice(service.length + 1) })),
  isAvailable: async () => true,
};

const buildResolver = (entries: SecretsJsonlEntry[] = []) =>
  new DefaultOpaqueRefResolver({
    keychain,
    auditLogWriter: {
      appendSecretResolution: async (entry) => {
        entries.push(entry);
      },
    },
  });

const baseContext = {
  taskParams: { month: '2026-04', user: 'alice' },
  captures: {
    s1: { amount: 42, currency: 'USD' },
    s2: 'plain-capture',
  },
  stepId: 's10',
  taskId: 'task-1',
} as const;

describe('@no-llm opaque ref resolver', () => {
  it('resolves all non-secret ValueRef kinds', async () => {
    const resolver = buildResolver();

    const literal = await resolver.resolve({ kind: 'literal', value: 123 }, baseContext);
    const param = await resolver.resolve({ kind: 'param', key: 'month' }, baseContext);
    const captureObj = await resolver.resolve(
      { kind: 'capture', step_id: 's1', field: 'currency' },
      baseContext,
    );
    const captureWhole = await resolver.resolve(
      { kind: 'capture', step_id: 's2', field: null },
      baseContext,
    );
    const templated = await resolver.resolve(
      {
        kind: 'template',
        template: 'month={{m}} user={{u}}',
        bindings: {
          m: { kind: 'param', key: 'month' },
          u: { kind: 'param', key: 'user' },
        },
      },
      baseContext,
    );

    expect(literal.value).toBe('123');
    expect(param.value).toBe('2026-04');
    expect(captureObj.value).toBe('USD');
    expect(captureWhole.value).toBe('plain-capture');
    expect(templated.value).toBe('month=2026-04 user=alice');
  });

  it('resolves secret refs, records audit metadata, and supports dispose()', async () => {
    const entries: SecretsJsonlEntry[] = [];
    const resolver = buildResolver(entries);
    await keychain.set('yantra', 'bank.password', 'pw-123');

    const fillSpy = vi.spyOn(Buffer.prototype, 'fill');

    const resolved = await resolver.resolve({ kind: 'secret', key: 'bank.password' }, baseContext);
    expect(resolved.isSecret).toBe(true);
    expect(resolved.value).toBe('pw-123');

    resolved.dispose();

    expect(fillSpy).toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('bank.password');
    expect(entries[0]?.outcome).toBe('resolved');

    fillSpy.mockRestore();
  });

  it('throws SecretNotFoundError and logs not_found outcome', async () => {
    const entries: SecretsJsonlEntry[] = [];
    const resolver = buildResolver(entries);

    await expect(
      resolver.resolve({ kind: 'secret', key: 'bank.missing' }, baseContext),
    ).rejects.toBeInstanceOf(SecretNotFoundError);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.outcome).toBe('not_found');
  });

  it('rejects literal values in secret-only fields (defense in depth)', async () => {
    const resolver = buildResolver();

    await expect(
      resolver.resolve(
        { kind: 'literal', value: 'plaintext-secret' },
        { ...baseContext, secretFieldExpected: true },
      ),
    ).rejects.toThrow('Literal value provided for a secret-only field');
  });

  it('property: resolve returns a value or throws typed errors without panicking', () => {
    const resolver = buildResolver();

    const valueRefArbitrary: fc.Arbitrary<ValueRef> = fc.oneof(
      fc.constant({ kind: 'literal', value: 'abc' } as const),
      fc.constant({ kind: 'literal', value: 1 } as const),
      fc.constant({ kind: 'param', key: 'month' } as const),
      fc.constant({ kind: 'param', key: 'missing' } as const),
      fc.constant({ kind: 'capture', step_id: 's1', field: 'amount' } as const),
      fc.constant({ kind: 'capture', step_id: 'missing', field: null } as const),
      fc.constant({ kind: 'secret', key: 'bank.password' } as const),
      fc.constant({ kind: 'secret', key: 'missing.secret' } as const),
      fc.constant({
        kind: 'template',
        template: 'month={{x}}',
        bindings: { x: { kind: 'param', key: 'month' } },
      } as const),
    );

    return fc.assert(
      fc.asyncProperty(valueRefArbitrary, async (ref) => {
        await keychain.set('yantra', 'bank.password', 'pw-123');

        try {
          const resolved = await resolver.resolve(ref, baseContext);
          expect(typeof resolved.value).toBe('string');
          resolved.dispose();
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 300 },
    );
  });
});
