import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isLuhnValid,
  redactApiKeyShapes,
  redactCreditCards,
  redactEmails,
  redactPhones,
  redactSsn,
  stripAuthQueryParams,
  stripFormValues,
  stripQueryStrings,
} from '../../src/sanitizer/strippers.js';

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const API_KEY_RE =
  /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xoxb-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/;

const VALID_CARDS = [
  '4111111111111111',
  '4012888888881881',
  '5555555555554444',
  '378282246310005',
  '6011111111111117',
] as const;

const INVALID_CARDS = ['4111111111111112', '4012888888881882', '5555555555554445'] as const;

describe('@no-llm sanitizer strippers', () => {
  it('stripFormValues removes input/textarea/contenteditable values', () => {
    const html =
      '<form><input value="secret"><textarea>notes</textarea><div contenteditable="true">abc</div></form>';
    const result = stripFormValues(html);

    expect(result.hits).toBe(3);
    expect(result.text).not.toContain('secret');
    expect(result.text).not.toContain('notes');
    expect(result.text).not.toContain('abc');
  });

  it('property: stripFormValues removes generated input values', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((value) => !/["'<>\n\r]/.test(value)),
        (value) => {
          const html = `<input type="text" value="${value}">`;
          const result = stripFormValues(html);

          expect(result.text.includes(`value="${value}"`)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: stripAuthQueryParams removes token-like query keys', () => {
    fc.assert(
      fc.property(fc.webUrl(), fc.string({ minLength: 5, maxLength: 20 }), (baseUrl, token) => {
        const url = new URL(baseUrl);
        url.searchParams.set('access_token', token);
        url.searchParams.set('q', 'kept');

        const sanitized = stripAuthQueryParams(url.toString());
        expect(sanitized.text.includes('access_token')).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it('stripQueryStrings removes full query sections while preserving hashes', () => {
    const input = 'https://example.com/path?q=1#frag';
    const result = stripQueryStrings(input);

    expect(result.text).toContain('#frag');
    expect(result.text).not.toContain('?q=1');
  });

  it('property: redactEmails strips generated email addresses', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 3, maxLength: 10 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
        fc.string({ minLength: 3, maxLength: 8 }).filter((s) => /^[a-z0-9]+$/i.test(s)),
        (user, domain) => {
          const email = `${user}@${domain}.com`;
          const result = redactEmails(`email=${email}`);

          expect(EMAIL_RE.test(result.text)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: redactSsn strips generated SSNs', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 999 }),
        fc.integer({ min: 10, max: 99 }),
        fc.integer({ min: 1000, max: 9999 }),
        (a, b, c) => {
          const ssn = `${a}-${b}-${c}`;
          const result = redactSsn(`ssn=${ssn}`);

          expect(SSN_RE.test(result.text)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('Luhn validator accepts known valid numbers and rejects invalid ones', () => {
    for (const card of VALID_CARDS) {
      expect(isLuhnValid(card)).toBe(true);
    }

    for (const card of INVALID_CARDS) {
      expect(isLuhnValid(card)).toBe(false);
    }
  });

  it('property: redactCreditCards redacts only Luhn-valid cards', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_CARDS),
        fc.constantFrom(...INVALID_CARDS),
        (valid, bad) => {
          const mixed = `${valid} ${bad}`;
          const result = redactCreditCards(mixed);

          expect(result.text.includes(valid)).toBe(false);
          expect(result.text.includes(bad)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: redactPhones strips phone-like values with 10-15 digits', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 10, maxLength: 12 }),
        (digits) => {
          const phone = digits.join('');
          const input = `call +1 (${phone.slice(0, 3)})-${phone.slice(3, 6)}-${phone.slice(6, 10)}`;
          const result = redactPhones(input);

          expect(/\d{3}[-)]\d{3}[-]\d{4}/.test(result.text)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: redactApiKeyShapes removes synthetic key shapes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'sk-abcdefghijklmnopqrstuvwxyz123456',
          'ghp_abcdefghijklmnopqrstuvwxyz1234',
          'AKIA1234567890ABCDEF',
          'xoxb-1234567890-abcdefghij',
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmb28ifQ.signaturetoken',
        ),
        (token) => {
          const result = redactApiKeyShapes(`token=${token}`);
          expect(API_KEY_RE.test(result.text)).toBe(false);
        },
      ),
      { numRuns: 200 },
    );
  });
});
