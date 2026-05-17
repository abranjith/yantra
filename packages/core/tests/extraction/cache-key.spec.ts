import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cacheKey, normalizeQueryForCache, utcDayFrom } from '../../src/extraction/cache-key.js';

describe('@no-llm extraction/cache-key', () => {
  it('normalizes query whitespace and casing', () => {
    expect(normalizeQueryForCache('  Today   TOP   News  ')).toBe('today top news');
  });

  it('extracts utc day from ISO string', () => {
    expect(utcDayFrom('2026-05-11T10:14:00.000Z')).toBe('2026-05-11');
  });

  it('is deterministic for the same triple', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.constantFrom<'tavily' | 'brave' | 'browser'>('tavily', 'brave', 'browser'),
        // Bound the date so toISOString() never throws RangeError on invalid epoch.
        fc.date({ noInvalidDate: true, min: new Date('1970-01-01'), max: new Date('2099-12-31') }),
        (query, provider, day) => {
          const utcDay = day.toISOString().slice(0, 10);
          const left = cacheKey(query, provider, utcDay);
          const right = cacheKey(query, provider, utcDay);
          expect(left).toBe(right);
        },
      ),
    );
  });

  it('changes when any component changes', () => {
    const one = cacheKey('query one', 'tavily', '2026-05-11');
    const two = cacheKey('query two', 'tavily', '2026-05-11');
    const three = cacheKey('query one', 'brave', '2026-05-11');
    const four = cacheKey('query one', 'tavily', '2026-05-12');

    expect(one).not.toBe(two);
    expect(one).not.toBe(three);
    expect(one).not.toBe(four);
  });
});
