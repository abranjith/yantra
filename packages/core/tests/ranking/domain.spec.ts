import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeDomain } from '../../src/ranking/domain.js';

const labelArbitrary = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), {
    minLength: 1,
    maxLength: 20,
  })
  .map((chars) => chars.join(''));

const domainArbitrary = fc
  .tuple(labelArbitrary, labelArbitrary, fc.boolean())
  .map(([left, right, includeThird]) =>
    includeThird ? `${left}.${right}.com` : `${left}.${right}`,
  );

describe('@no-llm normalizeDomain', () => {
  it('is idempotent for every accepted hostname', () => {
    fc.assert(
      fc.property(domainArbitrary, (domain) => {
        const first = normalizeDomain(domain);
        expect(first.isOk).toBe(true);
        if (!first.isOk) return;

        const second = normalizeDomain(first.value);
        expect(second).toEqual(first);
      }),
    );
  });

  it('is case-insensitive and trims surrounding whitespace', () => {
    fc.assert(
      fc.property(domainArbitrary, (domain) => {
        const lower = normalizeDomain(domain);
        const upper = normalizeDomain(`  ${domain.toUpperCase()}  `);
        expect(upper).toEqual(lower);
      }),
    );
  });

  it('strips exactly one leading www label', () => {
    expect(normalizeDomain('www.Example.COM')).toMatchObject({ isOk: true, value: 'example.com' });
    expect(normalizeDomain('www.www.example.com')).toMatchObject({
      isOk: true,
      value: 'www.example.com',
    });
  });

  it.each([
    '',
    '   ',
    'com',
    'https://a.com',
    'a.com/path',
    'a.com:8080',
    'user@a.com',
    'bad_domain.example',
    'a .com',
  ])('rejects invalid hostname shape %j', (input) => {
    const result = normalizeDomain(input);
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.message.length).toBeGreaterThan(0);
  });

  it('rejects non-ASCII domains with an actionable message', () => {
    const result = normalizeDomain('münich.example');
    expect(result.isOk).toBe(false);
    if (!result.isOk) expect(result.error.message).toContain('ASCII');
  });
});
