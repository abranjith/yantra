import { describe, expect, it } from 'vitest';

import { UrlProvenance } from '../../src/runtime/url-provenance.js';

/** The fabricated deep link from run 20260803T033803Z-do-f1d9f01b. */
const FABRICATED =
  'https://www.kayak.com/hotels/Chicago,IL-c17823/2026-08-05/2026-08-07/1adults;map?sort=price_a';

describe('@no-llm UrlProvenance matching', () => {
  it('matches a recorded URL exactly', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a/b');

    expect(provenance.has('https://example.com/a/b')).toBe(true);
  });

  it('does not match a URL that was never recorded', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a');

    expect(provenance.has('https://example.com/b')).toBe(false);
  });

  it('matches the bare origin of any recorded URL', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/deep/page?q=1');

    expect(provenance.has('https://example.com/')).toBe(true);
    expect(provenance.has('https://example.com')).toBe(true);
  });

  it('does not match the origin of a host it never saw', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/a');

    expect(provenance.has('https://other.com/')).toBe(false);
  });

  it('treats one trailing slash on a non-root path as insignificant', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://www.kayak.com/hotels/');

    expect(provenance.has('https://www.kayak.com/hotels')).toBe(true);
    expect(provenance.has('https://www.kayak.com/hotels/')).toBe(true);
  });

  it('ignores the fragment', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/page#section-2');

    expect(provenance.has('https://example.com/page')).toBe(true);
    expect(provenance.has('https://example.com/page#other')).toBe(true);
  });

  it('treats the query string as significant', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://example.com/search?a=1');

    expect(provenance.has('https://example.com/search?a=1')).toBe(true);
    expect(provenance.has('https://example.com/search?a=2')).toBe(false);
    expect(provenance.has('https://example.com/search')).toBe(false);
  });

  it('matches the host case-insensitively but the path case-sensitively', () => {
    const provenance = new UrlProvenance();
    provenance.record('https://Example.COM/Path');

    expect(provenance.has('https://example.com/Path')).toBe(true);
    expect(provenance.has('HTTPS://EXAMPLE.COM/Path')).toBe(true);
    expect(provenance.has('https://example.com/path')).toBe(false);
  });

  it('distinguishes ports and schemes', () => {
    const provenance = new UrlProvenance();
    provenance.record('http://localhost:8080/a');

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
    provenance.record('https://www.kayak.com/hotels/');

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
    provenance.record('https://www.kayak.com/hotels/');

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
