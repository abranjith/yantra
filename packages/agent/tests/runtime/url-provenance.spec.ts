import { describe, expect, it } from 'vitest';

import { UrlProvenance, extractUrls, provenanceDetails } from '../../src/runtime/url-provenance.js';

/** The fabricated deep link from run 20260803T033803Z-do-f1d9f01b. */
const FABRICATED =
  'https://www.kayak.com/hotels/Chicago,IL-c17823/2026-08-05/2026-08-07/1adults;map?sort=price_a';

describe('@no-llm UrlProvenance matching', () => {
  it('matches a recorded URL exactly', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a/b', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://example.com/a/b')).toBe(true);
  });

  it('does not match a URL that was never recorded', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://example.com/b')).toBe(false);
  });

  it('matches the bare origin of any recorded URL', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/deep/page?q=1', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://example.com/')).toBe(true);
    expect(provenance.has('https://example.com')).toBe(true);
  });

  it('does not match the origin of a host it never saw', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://other.com/')).toBe(false);
  });

  it('treats one trailing slash on a non-root path as insignificant', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://www.kayak.com/hotels/', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://www.kayak.com/hotels')).toBe(true);
    expect(provenance.has('https://www.kayak.com/hotels/')).toBe(true);
  });

  it('ignores the fragment', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/page#section-2', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://example.com/page')).toBe(true);
    expect(provenance.has('https://example.com/page#other')).toBe(true);
  });

  it('allows query-value variants and key subsets on an attested origin + path', () => {
    const provenance = new UrlProvenance();
    provenance.record(
      'https://x.test/Hotel-Search?destination=Frisco&d1=2026-08-06&d2=2026-08-07',
      { kind: 'tool', tool: 'test' },
    );

    expect(
      provenance.has('https://x.test/Hotel-Search?destination=Frisco&d1=2026-08-06&d2=2026-08-08'),
    ).toBe(true);
    expect(provenance.has('https://x.test/Hotel-Search?destination=Frisco&d1=2026-08-06')).toBe(
      true,
    );
    expect(provenance.has('https://x.test/Hotel-Search')).toBe(true);
    expect(provenance.has('https://x.test/Hotel-Search?destination=Frisco&cityId=c17823')).toBe(
      false,
    );
    expect(provenance.has('https://x.test/hotels/Chicago,IL-c17823/2026-08-05')).toBe(false);
    expect(provenance.has('https://y.test/Hotel-Search?destination=Frisco')).toBe(false);
  });

  it('does not grant a parameter name after recording a query-less URL', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://x.test/a', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://x.test/a?q=1')).toBe(false);
  });

  it('accumulates known parameter names across records', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://x.test/a?a=1', { kind: 'tool', tool: 'test' });
    provenance.record('https://x.test/a?b=2', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://x.test/a?a=9&b=9')).toBe(true);
    expect(provenance.has('https://x.test/a?a=9&c=9')).toBe(false);
  });

  it('normalizes trailing slashes in origin + path query buckets', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://x.test/hotels/?x=1', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://x.test/hotels?x=2')).toBe(true);
  });

  it('matches the host case-insensitively but the path case-sensitively', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://Example.COM/Path', { kind: 'tool', tool: 'test' });

    expect(provenance.has('https://example.com/Path')).toBe(true);
    expect(provenance.has('HTTPS://EXAMPLE.COM/Path')).toBe(true);
    expect(provenance.has('https://example.com/path')).toBe(false);
  });

  it('distinguishes ports and schemes', () => {
    const provenance = new UrlProvenance();
    provenance.record('http://localhost:8080/a', { kind: 'tool', tool: 'test' });

    expect(provenance.has('http://localhost:8080/a')).toBe(true);
    expect(provenance.has('http://localhost:9090/a')).toBe(false);
    expect(provenance.has('https://localhost:8080/a')).toBe(false);
  });

  it('is inert on unparseable input rather than throwing', () => {
    const provenance = new UrlProvenance();

    expect(() => provenance.record('not a url')).not.toThrow();
    expect(provenance.size).toBe(0);
    expect(provenance.has('not a url')).toBe(false);
    expect(provenance.has('')).toBe(false);
  });

  it('refuses the exact fabricated deep link from the logged run', () => {
    // The logged sequence: the run legitimately reached the hotels index, then
    // assembled a deep link with a made-up city id that served a different city.
    const provenance = new UrlProvenance();
    provenance.record('https://www.kayak.com/hotels/', { kind: 'tool', tool: 'test' });

    expect(provenance.has(FABRICATED)).toBe(false);
  });
});

describe('@no-llm UrlProvenance seeding', () => {
  it('grants an allowlisted host any path, scheme, and port', () => {
    // `--allow-host` is an explicit human statement of where the run should
    // work, and is itself the attestation that the host is right. Restricting
    // it to the origin root would refuse the first navigation of an ordinary
    // run, and would never match at all on an http or non-default-port host.
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['127.0.0.1'] });

    expect(provenance.has('http://127.0.0.1:8931/form.html')).toBe(true);
    expect(provenance.has('https://127.0.0.1/')).toBe(true);
    expect(provenance.has('http://127.0.0.1:8931/deep/page?a=1')).toBe(true);
  });

  it('confines a host grant to that host', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['example.com'] });

    expect(provenance.has('https://example.com/anything')).toBe(true);
    expect(provenance.has('https://evil.com/')).toBe(false);
    // A suffix match must not leak the grant to a lookalike host.
    expect(provenance.has('https://notexample.com/')).toBe(false);
    expect(provenance.has('https://example.com.evil.com/')).toBe(false);
  });

  it('does not grant a host the user never named', () => {
    // The logged failure was a fabricated path on a host reached organically,
    // never allowlisted — that case is unchanged.
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['example.com'] });
    provenance.record('https://www.kayak.com/hotels/', { kind: 'tool', tool: 'test' });

    expect(provenance.has(FABRICATED)).toBe(false);
  });

  it('accepts a host:port allow entry and ignores the port', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['localhost:3000'] });

    expect(provenance.has('http://localhost:9999/x')).toBe(true);
  });

  it('ignores blank and whitespace-only host entries', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['', '   '] });

    expect(provenance.has('https://example.com/')).toBe(false);
    expect(provenance.size).toBe(0);
  });

  it('seeds URLs written in the goal (the user typed them)', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ goal: 'track my parcel at https://track.example.com/status?id=42 please' });

    expect(provenance.has('https://track.example.com/status?id=42')).toBe(true);
  });

  it('strips trailing sentence punctuation from a goal URL', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ goal: 'summarize https://example.com/article.' });

    expect(provenance.has('https://example.com/article')).toBe(true);
  });

  it('seeds multiple goal URLs', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ goal: 'compare https://a.example.com/x and https://b.example.com/y' });

    expect(provenance.has('https://a.example.com/x')).toBe(true);
    expect(provenance.has('https://b.example.com/y')).toBe(true);
  });

  it('seeds nothing from a goal with no URLs', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ goal: 'cheap hotels near me' });

    expect(provenance.size).toBe(0);
  });

  it('accepts an empty seed', () => {
    const provenance = new UrlProvenance();
    provenance.seed({});

    expect(provenance.size).toBe(0);
  });
});

describe('@no-llm UrlProvenance origins and explain (FEAT-051)', () => {
  const TOOL = { kind: 'tool', tool: 'web_search' } as const;
  const DISCOVERED = { kind: 'discovered', sourceId: 'S3', linkKind: 'facet' } as const;

  it('keeps the first origin recorded for a normalized URL', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://shop.test/list/', TOOL);
    provenance.record('https://shop.test/list', DISCOVERED);

    expect(provenance.explain('https://shop.test/list')).toEqual({ match: 'exact', origin: TOOL });
  });

  it('names the granting origin for an origin-root match', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://shop.test/a/b', DISCOVERED);
    provenance.record('https://shop.test/c', TOOL);

    expect(provenance.explain('https://shop.test/')).toEqual({
      match: 'origin-root',
      origin: DISCOVERED,
    });
  });

  it('names the granting origin for a query-variant match', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://shop.test/list?page=2', DISCOVERED);

    expect(provenance.explain('https://shop.test/list?page=7')).toEqual({
      match: 'query-variant',
      origin: DISCOVERED,
    });
  });

  it('reports goal and allow-host origins from the seed', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['owned.test'], goal: 'read https://news.test/story' });

    expect(provenance.explain('https://news.test/story')).toEqual({
      match: 'exact',
      origin: { kind: 'goal' },
    });
    expect(provenance.explain('https://owned.test/any/path')).toEqual({
      match: 'allowed-host',
      origin: { kind: 'allow-host' },
    });
  });

  it('agrees with has() on every case of the existing matching table', () => {
    const provenance = new UrlProvenance();
    provenance.seed({ allowedHosts: ['localhost:3000'] });
    for (const url of [
      'https://example.com/a/b',
      'https://example.com/deep/page?q=1',
      'https://x.test/a?a=1',
      'https://x.test/a?b=2',
      'https://x.test/hotels/?x=1',
      'https://Example.COM/Path',
      'http://localhost:8080/a',
      'https://example.com/page#section-2',
    ]) {
      provenance.record(url, TOOL);
    }
    const candidates = [
      'https://example.com/a/b/',
      'https://example.com/a/c',
      'https://example.com/',
      'https://example.com',
      'https://example.com/deep/page?q=2',
      'https://example.com/deep/page?r=1',
      'https://x.test/a?a=9&b=8',
      'https://x.test/a?c=1',
      'https://x.test/hotels?x=2',
      'https://example.com/Path',
      'https://example.com/path',
      'http://localhost:8080/a',
      'http://localhost:9999/x',
      'https://example.com/page',
      'https://other.test/',
      'not a url',
    ];
    for (const candidate of candidates) {
      expect({ candidate, explained: provenance.explain(candidate) !== null }).toEqual({
        candidate,
        explained: provenance.has(candidate),
      });
    }
  });

  it('explains nothing for an unattested or unparseable URL', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://shop.test/a', TOOL);

    expect(provenance.explain('https://shop.test/b')).toBeNull();
    expect(provenance.explain('::')).toBeNull();
  });

  it('projects explanations into audit details without page text', () => {
    expect(provenanceDetails(null)).toEqual({ match: 'none', kind: 'none' });
    expect(provenanceDetails({ match: 'exact', origin: DISCOVERED })).toEqual({
      match: 'exact',
      kind: 'discovered',
      via: 'S3',
      link_kind: 'facet',
    });
    expect(provenanceDetails({ match: 'query-variant', origin: TOOL })).toEqual({
      match: 'query-variant',
      kind: 'tool',
      tool: 'web_search',
    });
    expect(provenanceDetails({ match: 'exact', origin: { kind: 'goal' } })).toEqual({
      match: 'exact',
      kind: 'goal',
    });
  });

  it('extracts URLs from free text with the goal grammar', () => {
    expect(extractUrls('see https://a.test/x, and (https://b.test/y).')).toEqual([
      'https://a.test/x',
      'https://b.test/y',
    ]);
  });
});
