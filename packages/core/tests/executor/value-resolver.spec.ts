import { describe, expect, it } from 'vitest';

import { ValueResolver } from '../../src/executor/value-resolver.js';
import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';
import type { SecretResolver } from '../../src/executor/types.js';

const makeCaptures = (entries: Record<string, unknown> = {}) => {
  const store = new InMemoryCaptureStore();
  for (const [k, v] of Object.entries(entries)) store.set(k, v);
  return store;
};

const makeSecrets = (map: Record<string, string> = {}): SecretResolver => ({
  resolve: (ref) => {
    const val = map[ref.key];
    if (val === undefined) throw new Error(`Secret not found: ${ref.key}`);
    return Promise.resolve(val);
  },
});

describe('@no-llm ValueResolver', () => {
  describe('literal', () => {
    it('resolves a literal string value', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      const result = await r.resolve({ kind: 'literal', value: 'hello' });
      expect(result).toBe('hello');
    });

    it('resolves a literal number', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      const result = await r.resolve({ kind: 'literal', value: 42 });
      expect(result).toBe(42);
    });

    it('resolves a literal boolean', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      expect(await r.resolve({ kind: 'literal', value: true })).toBe(true);
    });

    it('resolves a literal null', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      expect(await r.resolve({ kind: 'literal', value: null })).toBeNull();
    });
  });

  describe('param', () => {
    it('resolves a param from the params map', async () => {
      const r = new ValueResolver(makeCaptures(), { userid: 'u-123' }, makeSecrets());
      const result = await r.resolve({ kind: 'param', key: 'userid' });
      expect(result).toBe('u-123');
    });

    it('throws when param is missing', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      await expect(r.resolve({ kind: 'param', key: 'missing' })).rejects.toThrow('missing');
    });
  });

  describe('capture', () => {
    it('resolves the whole capture when field is null', async () => {
      const store = makeCaptures();
      store.set('s1', { amount: 42 });
      const r = new ValueResolver(store, {}, makeSecrets());
      const result = await r.resolve({ kind: 'capture', step_id: 's1', field: null });
      expect(result).toEqual({ amount: 42 });
    });

    it('resolves a specific field from a capture', async () => {
      const store = makeCaptures();
      store.set('s1', { email: 'test@example.com', age: 30 });
      const r = new ValueResolver(store, {}, makeSecrets());
      const result = await r.resolve({ kind: 'capture', step_id: 's1', field: 'email' });
      expect(result).toBe('test@example.com');
    });

    it('throws when capture step_id is missing', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      await expect(r.resolve({ kind: 'capture', step_id: 's99', field: null })).rejects.toThrow('s99');
    });

    it('throws when capture field is missing', async () => {
      const store = makeCaptures();
      store.set('s1', { a: 1 });
      const r = new ValueResolver(store, {}, makeSecrets());
      await expect(r.resolve({ kind: 'capture', step_id: 's1', field: 'missing' })).rejects.toThrow();
    });
  });

  describe('template', () => {
    it('interpolates a binding into the template', async () => {
      const r = new ValueResolver(makeCaptures(), { myname: 'World' }, makeSecrets());
      const result = await r.resolve({
        kind: 'template',
        template: 'Hello {{myname}}!',
        bindings: { myname: { kind: 'param', key: 'myname' } },
      });
      expect(result).toBe('Hello World!');
    });

    it('interpolates multiple bindings', async () => {
      const r = new ValueResolver(makeCaptures(), { a: 'foo', b: 'bar' }, makeSecrets());
      const result = await r.resolve({
        kind: 'template',
        template: '{{a}}-{{b}}',
        bindings: {
          a: { kind: 'param', key: 'a' },
          b: { kind: 'param', key: 'b' },
        },
      });
      expect(result).toBe('foo-bar');
    });

    it('rejects template refs with secret bindings', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets({ 'ns.pwd': 'hunter2' }));
      await expect(
        r.resolve({
          kind: 'template',
          template: 'pass={{mySecret}}',
          bindings: { mySecret: { kind: 'secret', key: 'ns.pwd' } },
        }),
      ).rejects.toThrow();
    });
  });

  describe('resolveToString', () => {
    it('coerces numeric literal to string', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets());
      const result = await r.resolveToString({ kind: 'literal', value: 123 });
      expect(result).toBe('123');
    });

    it('throws for secret refs', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets({ 'ns.key': 'val' }));
      await expect(r.resolveToString({ kind: 'secret', key: 'ns.key' })).rejects.toThrow();
    });
  });

  describe('secrets — security invariants', () => {
    it('resolveSecret returns plaintext and a zero function', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets({ 'api.key': 'super-secret' }));
      const { plaintext, zero } = await r.resolveSecret({ kind: 'secret', key: 'api.key' });
      expect(plaintext).toBe('super-secret');
      expect(typeof zero).toBe('function');
      zero();
    });

    it('calling zero() twice does not throw', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets({ 'api.key': 'val' }));
      const { zero } = await r.resolveSecret({ kind: 'secret', key: 'api.key' });
      zero();
      expect(() => zero()).not.toThrow();
    });

    it('secrets are never returned by resolve()', async () => {
      const r = new ValueResolver(makeCaptures(), {}, makeSecrets({ 'ns.pwd': 'hunter2' }));
      await expect(r.resolve({ kind: 'secret', key: 'ns.pwd' })).rejects.toThrow();
    });

    it('resolveSecret throws when no SecretResolver is configured', async () => {
      const r = new ValueResolver(makeCaptures(), {}, null);
      await expect(r.resolveSecret({ kind: 'secret', key: 'ns.key' })).rejects.toThrow();
    });
  });
});
