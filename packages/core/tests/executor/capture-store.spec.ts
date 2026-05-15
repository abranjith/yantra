import { describe, expect, it } from 'vitest';

import { InMemoryCaptureStore } from '../../src/executor/capture-store.js';

describe('@no-llm InMemoryCaptureStore', () => {
  describe('basic get/set/has/keys', () => {
    it('stores and retrieves values', () => {
      const store = new InMemoryCaptureStore();
      store.set('name', 'Alice');
      expect(store.get('name')).toBe('Alice');
    });

    it('has() returns false for absent key', () => {
      const store = new InMemoryCaptureStore();
      expect(store.has('missing')).toBe(false);
    });

    it('has() returns true after set', () => {
      const store = new InMemoryCaptureStore();
      store.set('x', 1);
      expect(store.has('x')).toBe(true);
    });

    it('keys() returns all stored keys', () => {
      const store = new InMemoryCaptureStore();
      store.set('a', 1);
      store.set('b', 2);
      expect(store.keys()).toEqual(expect.arrayContaining(['a', 'b']));
    });

    it('get() returns undefined for missing key', () => {
      const store = new InMemoryCaptureStore();
      expect(store.get('nope')).toBeUndefined();
    });
  });

  describe('snapshot / restore round-trip', () => {
    it('snapshot captures current entries', () => {
      const store = new InMemoryCaptureStore();
      store.set('a', 1);
      store.set('b', 'hello');
      const snap = store.snapshot();
      expect(snap.entries['a']).toBe(1);
      expect(snap.entries['b']).toBe('hello');
    });

    it('restore replaces store contents with snapshot', () => {
      const store = new InMemoryCaptureStore();
      store.set('original', true);
      const snap = store.snapshot();

      store.set('added_after', 'ignored');
      store.restore(snap);

      expect(store.has('original')).toBe(true);
      expect(store.has('added_after')).toBe(false);
    });

    it('modifications after snapshot do not affect the snapshot', () => {
      const store = new InMemoryCaptureStore();
      store.set('v', 1);
      const snap = store.snapshot();

      store.set('v', 99);
      // snap.entries should still reflect v=1
      expect(snap.entries['v']).toBe(1);
    });

    it('snapshot / restore is idempotent when nothing changes', () => {
      const store = new InMemoryCaptureStore();
      store.set('k', 42);
      const snap1 = store.snapshot();
      store.restore(snap1);
      const snap2 = store.snapshot();
      expect(snap2.entries).toEqual(snap1.entries);
    });
  });

  describe('large value sidecar handling', () => {
    it('inlines small values normally', () => {
      const store = new InMemoryCaptureStore();
      store.set('small', 'tiny');
      const snap = store.snapshot({ inlineLimitBytes: 1024 });
      expect(snap.entries['small']).toBe('tiny');
      expect(Object.keys(snap.sidecars)).toHaveLength(0);
    });

    it('stores oversized values as sidecar references', () => {
      const store = new InMemoryCaptureStore();
      const bigValue = 'x'.repeat(65 * 1024); // 65 KB
      store.set('bigKey', bigValue);
      const snap = store.snapshot(); // default limit is 64 KB
      // Entry becomes a sidecar ref object
      expect(snap.entries['bigKey']).toMatchObject({ $ref: 'bigKey' });
      // sidecars map contains the key name (the actual blob is referenced by key)
      expect('bigKey' in snap.sidecars).toBe(true);
    });
  });
});
