/**
 * The one identity function for "same page" (FEAT-050).
 *
 * Two readers need to agree on when two URLs name the same document: the
 * deterministic research corpus (`SourcePool`, which drops exact duplicates so
 * corroboration is not inflated) and the agentic run's document store (which
 * reads each page once and mints one evidence ID per page). One function owns
 * that decision so the two can never disagree about what a repeat is.
 */

/**
 * Tracking / analytics query parameters stripped during canonicalization so
 * the same page linked with different campaign tags is one page.
 */
const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'spm',
  '_ga',
]);

/**
 * Canonicalizes a URL for page identity: lowercased host, no fragment,
 * tracking parameters stripped, one trailing slash removed from a non-root
 * path, and the scheme's default port dropped. Unparseable input falls back
 * to a trimmed lowercase string, so it is still a stable key.
 *
 * @param raw - The URL to canonicalize.
 * @returns A stable identity string; equal strings name the same page.
 *
 * @example
 * canonicalUrl('https://A.com:443/x/?utm_source=n#frag'); // 'https://a.com/x'
 */
export function canonicalUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // swallow-ok: an unparseable URL is still a usable identity key.
    return raw.trim().toLowerCase();
  }

  url.hash = '';
  // The WHATWG parser already lowercases the host and empties a port equal to
  // the scheme's default (`https://a.com:443` → `https://a.com`), which is the
  // default-port rule; nothing here re-implements it.
  url.hostname = url.hostname.toLowerCase();

  for (const param of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      url.searchParams.delete(param);
    }
  }

  // Drop a trailing slash on non-root paths ('/a/' == '/a'), keep root '/'.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/u, '');
  }

  const query = url.searchParams.toString();
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
}
