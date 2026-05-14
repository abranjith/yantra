/// <reference lib="dom" />

/**
 * Text normalization and matching utilities for the locator engine.
 * Used by role, label, text-content, and placeholder strategies.
 */

/**
 * Normalizes a string by trimming and collapsing all whitespace sequences
 * (including NBSP, tab, CRLF) to a single ASCII space.
 *
 * @example
 * normalizeText('  hello world\n') // -> 'hello world'
 * normalizeText('\r\nfoo\tbar  ') // -> 'foo bar'
 */
export function normalizeText(s: string): string {
  // Matches regular whitespace plus NBSP (\u00A0), ZWSP (\u200B), NNBSP (\u202F), BOM (\uFEFF)
  return s.replace(/[\s\u00A0\u200B\u202F\uFEFF]+/g, ' ').trim();
}

/**
 * Tests whether a haystack string matches the given matcher (string or RegExp).
 *
 * When `exact` is true (default for string matchers): full-string equality
 * after normalization.
 * When exact is false: the haystack contains the needle (normalized, case-insensitive).
 * When matcher is a RegExp: regex.test(haystack) -- normalization applied first
 * if 
ormalize is true.
 *
 * @example
 * matchText('Sign in', 'Sign in', true) // -> true
 * matchText('Click here to Sign in', 'sign in', false) // -> true
 * matchText('Sign in', /sign/i) // -> true
 */
export function matchText(
  haystack: string,
  matcher: string | RegExp,
  exact = true,
  normalize = true,
): boolean {
  const normalized = normalize ? normalizeText(haystack) : haystack;

  if (matcher instanceof RegExp) {
    return matcher.test(normalized);
  }

  const needle = normalize ? normalizeText(matcher) : matcher;

  if (exact) {
    return normalized === needle;
  }

  // Case-insensitive contains
  return normalized.toLowerCase().includes(needle.toLowerCase());
}
