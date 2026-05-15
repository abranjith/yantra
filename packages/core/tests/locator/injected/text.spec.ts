// @vitest-environment jsdom

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { matchText, normalizeText } from '../../../src/locator/injected/text.js';

describe('@no-llm normalizeText', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeText('  hello  ')).toBe('hello');
  });

  it('collapses multiple spaces to one', () => {
    expect(normalizeText('foo   bar')).toBe('foo bar');
  });

  it('collapses CRLF to single space', () => {
    expect(normalizeText('foo\r\nbar')).toBe('foo bar');
  });

  it('collapses tab to single space', () => {
    expect(normalizeText('foo\tbar')).toBe('foo bar');
  });

  it('collapses NBSP (\\u00a0) to single space', () => {
    expect(normalizeText('foo bar')).toBe('foo bar');
  });

  it('handles empty string', () => {
    expect(normalizeText('')).toBe('');
  });

  it('handles string with only whitespace', () => {
    expect(normalizeText('   \t\n  ')).toBe('');
  });
});

describe('@no-llm matchText', () => {
  it('exact string match returns true', () => {
    expect(matchText('Sign in', 'Sign in', true)).toBe(true);
  });

  it('exact match is case-sensitive', () => {
    expect(matchText('Sign in', 'sign in', true)).toBe(false);
  });

  it('non-exact match is case-insensitive contains', () => {
    expect(matchText('Click here to Sign in', 'sign in', false)).toBe(true);
  });

  it('non-exact match returns false when not contained', () => {
    expect(matchText('Log out', 'sign in', false)).toBe(false);
  });

  it('regex test returns true when matches', () => {
    expect(matchText('Sign in', /sign in/i)).toBe(true);
  });

  it('regex with flags works correctly', () => {
    expect(matchText('SIGN IN', /sign in/i)).toBe(true);
  });

  it('regex returns false when no match', () => {
    expect(matchText('Log out', /sign in/i)).toBe(false);
  });

  it('normalizes haystack before string match', () => {
    expect(matchText('  Sign  in  ', 'Sign in', true)).toBe(true);
  });

  it('exact match rejects substring', () => {
    expect(matchText('Sign in button', 'Sign in', true)).toBe(false);
  });

  it('skips normalization when normalize=false', () => {
    expect(matchText('  Sign in  ', 'Sign in', true, false)).toBe(false);
  });

  it('property: matchText(s, s, true) is true for any non-empty normalized string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        (s) => {
          const normalized = normalizeText(s);
          return normalized === '' || matchText(normalized, normalized, true);
        },
      ),
    );
  });
});
