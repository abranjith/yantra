import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { canonicalUrl } from '../../src/extraction/url-identity.js';
import { normalizeUrl } from '../../src/research/source-pool.js';

describe('@no-llm extraction/url-identity canonicalUrl', () => {
  it.each([
    ['https://a.com/x/?utm_source=n#frag', 'https://a.com/x'],
    ['https://A.COM/x', 'https://a.com/x'],
    ['https://a.com/x/', 'https://a.com/x'],
    ['https://a.com/', 'https://a.com/'],
    ['https://a.com', 'https://a.com/'],
    ['https://a.com/x?q=1&utm_medium=e', 'https://a.com/x?q=1'],
    ['https://a.com/x?gclid=z&FBCLID=y', 'https://a.com/x'],
    ['https://a.com:443/x', 'https://a.com/x'],
    ['http://a.com:80/x', 'http://a.com/x'],
    ['https://a.com:8443/x', 'https://a.com:8443/x'],
    ['http://a.com:443/x', 'http://a.com:443/x'],
  ])('canonicalizes %s to %s', (input, expected) => {
    expect(canonicalUrl(input)).toBe(expected);
  });

  it('treats the spec example pair as one page', () => {
    expect(canonicalUrl('https://A.com/x/?utm_source=n#f')).toBe(
      canonicalUrl('https://a.com:443/x'),
    );
  });

  it('keeps meaningful query parameters and their order', () => {
    expect(canonicalUrl('https://a.com/s?b=2&a=1')).toBe('https://a.com/s?b=2&a=1');
  });

  it('keeps the path case (paths are case-sensitive)', () => {
    expect(canonicalUrl('https://a.com/Path')).not.toBe(canonicalUrl('https://a.com/path'));
  });

  it('falls back to a trimmed lowercase string for an unparseable URL', () => {
    expect(canonicalUrl('  NOT a url ')).toBe('not a url');
    expect(canonicalUrl('')).toBe('');
  });

  it('is the same function the research corpus uses for page identity', () => {
    expect(normalizeUrl).toBe(canonicalUrl);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.webUrl({ withFragments: true, withQueryParameters: true }), (url) => {
        const once = canonicalUrl(url);
        expect(canonicalUrl(once)).toBe(once);
      }),
    );
  });
});
