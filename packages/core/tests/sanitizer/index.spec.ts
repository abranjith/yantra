import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitize } from '../../src/sanitizer/index.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const API_KEY_RE = /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xoxb-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;
const URL_QUERY_RE = /https?:\/\/[^\s"'<>]+\?[A-Za-z0-9]/i;

const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){13,19}\b/g;

const MARKER_BYTES = Buffer.byteLength('\n[...truncated by yantra sanitizer]', 'utf8');

const corpusArbitrary = fc.record({
  email: fc
    .tuple(
      fc.string({ minLength: 3, maxLength: 8 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
      fc.string({ minLength: 3, maxLength: 8 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
    )
    .map(([user, domain]) => `${user}@${domain}.com`),
  ssn: fc
    .tuple(
      fc.integer({ min: 100, max: 999 }),
      fc.integer({ min: 10, max: 99 }),
      fc.integer({ min: 1000, max: 9999 }),
    )
    .map(([a, b, c]) => `${a}-${b}-${c}`),
  creditCard: fc.constantFrom('4111111111111111', '4012888888881881', '5555555555554444'),
  apiKey: fc.constantFrom(
    'sk-abcdefghijklmnopqrstuvwxyz123456',
    'ghp_abcdefghijklmnopqrstuvwxyz1234',
    'AKIA1234567890ABCDEF',
  ),
  authUrl: fc.webUrl().map((value) => {
    const url = new URL(value);
    url.searchParams.set('access_token', 'secret-token');
    url.searchParams.set('q', 'kept');
    return url.toString();
  }),
  payloadPad: fc.string({ minLength: 0, maxLength: 64 }),
});

describe('@no-llm sanitizer chokepoint', () => {
  it('is idempotent for already-sanitized text', () => {
    const once = sanitize('email=test@example.com', 'public');
    const twice = sanitize(once.text, 'public');

    expect(twice.text).toBe(once.text);
  });

  it('is total for non-serializable payloads', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => sanitize(cyclic, 'authenticated')).not.toThrow();
  });

  it('public profile property: no PII or key shapes leak', () => {
    fc.assert(
      fc.property(corpusArbitrary, (item) => {
        const payload =
          `email=${item.email};ssn=${item.ssn};card=${item.creditCard};token=${item.apiKey};url=${item.authUrl};` +
          item.payloadPad;
        const result = sanitize(payload, 'public');

        expect(EMAIL_RE.test(result.text)).toBe(false);
        expect(SSN_RE.test(result.text)).toBe(false);
        expect(API_KEY_RE.test(result.text)).toBe(false);
        expect(hasLuhnCard(result.text)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('read-only-data profile property: payload remains byte-bounded and may keep PII', () => {
    fc.assert(
      fc.property(corpusArbitrary, (item) => {
        const base = `email=${item.email};ssn=${item.ssn};url=${item.authUrl};${item.payloadPad}`;
        const padded = base.repeat(200);
        const result = sanitize(padded, 'read-only-data');

        expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(20_480 + MARKER_BYTES);
      }),
      { numRuns: 500 },
    );
  });

  it('authenticated profile property: full query stripping + no public leaks', () => {
    fc.assert(
      fc.property(corpusArbitrary, (item) => {
        const payload =
          `email=${item.email};ssn=${item.ssn};card=${item.creditCard};token=${item.apiKey};` +
          `url=${item.authUrl};${item.payloadPad}`;
        const result = sanitize(payload, 'authenticated');

        expect(URL_QUERY_RE.test(result.text)).toBe(false);
        expect(EMAIL_RE.test(result.text)).toBe(false);
        expect(SSN_RE.test(result.text)).toBe(false);
        expect(API_KEY_RE.test(result.text)).toBe(false);
        expect(hasLuhnCard(result.text)).toBe(false);
      }),
      { numRuns: 500 },
    );
  });

  it('applies host-specific overrides when host hint matches', () => {
    const input = 'Balance: $12,344.99';
    const result = sanitize(input, 'authenticated', 'secure.chase.com');

    expect(result.text).toContain('[redacted-currency-usd]');
    expect(result.transformationsApplied).toContain('host-override-currency-usd');
  });
});

function hasLuhnCard(text: string): boolean {
  const matches = text.match(CARD_CANDIDATE_RE);
  if (!matches) {
    return false;
  }

  return matches.some((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) {
      return false;
    }

    let sum = 0;
    let shouldDouble = false;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let value = Number(digits[i]);
      if (shouldDouble) {
        value *= 2;
        if (value > 9) {
          value -= 9;
        }
      }
      sum += value;
      shouldDouble = !shouldDouble;
    }

    return sum % 10 === 0;
  });
}
