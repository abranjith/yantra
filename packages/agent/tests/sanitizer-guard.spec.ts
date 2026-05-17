/**
 * @no-llm Tests for the Sanitized<T> brand and runtime registry.
 */
import { describe, expect, it } from 'vitest';

import { SanitizerGuardError } from '../src/errors.js';
import { assertSanitized, brandSanitized, type Sanitized } from '../src/sanitizer-guard.js';

describe('brandSanitized + assertSanitized', () => {
  describe('brandSanitized strings', () => {
    it('registers string so assertSanitized passes', () => {
      const s = brandSanitized('hello world');
      expect(() => assertSanitized(s)).not.toThrow();
    });

    it('registers empty string', () => {
      const s = brandSanitized('');
      expect(() => assertSanitized(s)).not.toThrow();
    });

    it('each unique string is independently registered', () => {
      const a = brandSanitized('string-a');
      const b = brandSanitized('string-b');
      expect(() => assertSanitized(a)).not.toThrow();
      expect(() => assertSanitized(b)).not.toThrow();
    });
  });

  describe('assertSanitized — raw strings', () => {
    it('throws SanitizerGuardError for a raw string not through brandSanitized', () => {
      const raw = `raw-unregistered-${Math.random()}`;
      expect(() => assertSanitized(raw)).toThrow(SanitizerGuardError);
    });

    it('error message mentions sanitizer chokepoint', () => {
      const raw = `another-raw-${Math.random()}`;
      expect(() => assertSanitized(raw)).toThrowError(/sanitize\(\)/);
    });
  });

  describe('assertSanitized — objects', () => {
    it('registers object so assertSanitized passes', () => {
      const obj = { text: 'safe content' };
      const branded = brandSanitized(obj);
      expect(() => assertSanitized(branded)).not.toThrow();
    });

    it('throws for unregistered object', () => {
      const unregistered = { text: 'not registered' };
      expect(() => assertSanitized(unregistered)).toThrow(SanitizerGuardError);
    });
  });

  describe('assertSanitized — invalid types', () => {
    it('throws for null', () => {
      expect(() => assertSanitized(null)).toThrow(SanitizerGuardError);
    });

    it('throws for number', () => {
      expect(() => assertSanitized(42)).toThrow(SanitizerGuardError);
    });

    it('throws for undefined', () => {
      expect(() => assertSanitized(undefined)).toThrow(SanitizerGuardError);
    });
  });

  describe('type-level compile checks (documented)', () => {
    it('Sanitized<string> is assignable to string at value level', () => {
      const s: Sanitized<string> = brandSanitized('hello');
      const plain: string = s;
      expect(plain).toBe('hello');
    });
  });
});
