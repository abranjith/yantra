/**
 * Run-scoped record of every URL a tool actually produced.
 *
 * **Threat model.** A model that cannot reach a page through the interface will
 * try to reach it by construction — assembling a "deep link" from parameters it
 * believes are correct. The failure is silent, and that is what makes it
 * dangerous: in run `20260803T033803Z-do-f1d9f01b` the agent hand-built
 *
 *     https://www.kayak.com/hotels/Chicago,IL-c17823/2026-08-05/2026-08-07/1adults;map
 *
 * where `c17823` was a fabricated Kayak city id. The site did not error. It
 * served **"Shook, Missouri"** — eight cabins at Lake Wappapello.
 * `browser_navigate` returned `status: ok`, nothing flagged it, and the run
 * published hotel prices for a place the user had never heard of. A guessed URL
 * that 404s is a nuisance; a guessed URL that resolves to plausible-looking
 * wrong data is a correctness hole no amount of downstream verification closes,
 * because every later observation is faithfully reporting the wrong page.
 *
 * So navigation is restricted to URLs whose existence some tool result (or the
 * user's own goal text) actually attested to. This is a sibling of
 * `EvidenceLedger`: both are run-scoped, append-only records of what the run
 * legitimately saw, differing only in what they are consulted for.
 *
 * Matching is deliberately a little generous — an origin root always matches,
 * and one trailing slash is insignificant — because the cost of a false refusal
 * is a wasted turn, while the cost of a false accept is the failure above.
 * Query values may vary once an origin + path and every parameter name have
 * been attested; new paths and new parameter names remain refused, because
 * those are the places a fabricated identifier can hide.
 */

/**
 * Append-only set of URLs this run may navigate to.
 *
 * Seeded from the trusted inputs (`--allow-host` entries and URLs in the raw
 * goal), then extended by every tool that returns a URL.
 */
export class UrlProvenance {
  /** Normalized URLs seen this run. */
  private readonly urls = new Set<string>();
  /** Normalized origin roots (`https://host/`) of every recorded URL. */
  private readonly origins = new Set<string>();
  /** Query parameter names attested for each normalized origin + path. */
  private readonly queryKeysByOriginPath = new Map<string, Set<string>>();
  /** Hostnames the user explicitly allowlisted; see {@link allowHost}. */
  private readonly allowedHosts = new Set<string>();

  /**
   * Records a URL a tool produced. Unparseable input is ignored rather than
   * thrown: provenance is a permission record, and a malformed string simply
   * grants nothing.
   *
   * @param url - The URL as the tool reported it.
   */
  public record(url: string): void {
    const parsed = parse(url);
    if (parsed === null) return;
    this.urls.add(parsed.normalized);
    this.origins.add(parsed.origin);
    const keys = this.queryKeysByOriginPath.get(parsed.originPath) ?? new Set<string>();
    for (const key of parsed.queryKeys) keys.add(key);
    this.queryKeysByOriginPath.set(parsed.originPath, keys);
  }

  /**
   * Whether this run may navigate to `url`.
   *
   * True on a normalized exact match, or when the candidate is the bare origin
   * of any recorded URL — backing out to a site's root is always reachable by
   * clicking its logo, so refusing it would be a false positive with no safety
   * value.
   *
   * @param url - The candidate navigation target.
   */
  public has(url: string): boolean {
    const parsed = parse(url);
    if (parsed === null) return false;
    if (this.allowedHosts.has(parsed.hostname)) return true;
    if (this.urls.has(parsed.normalized)) return true;
    if (parsed.isOriginRoot && this.origins.has(parsed.origin)) return true;
    const knownKeys = this.queryKeysByOriginPath.get(parsed.originPath);
    return knownKeys !== undefined && parsed.queryKeys.every((key) => knownKeys.has(key));
  }

  /**
   * Grants blanket permission for a hostname the **user** named
   * (`--allow-host`), independent of scheme, port, and path.
   *
   * This is deliberately broader than a recorded URL. `--allow-host` is an
   * explicit human statement of where the run should work, and it is itself the
   * attestation that the host is the right one — the failure this class exists
   * to prevent was a fabricated path on a host the user never named, reached
   * organically mid-run. Restricting an allowlisted host to its origin root
   * would refuse the first navigation of an ordinary `--allow-host` run (and
   * would silently never match at all on an http or non-default-port host,
   * since a seeded `https://host/` matches neither).
   *
   * @param host - Hostname, optionally with a port; the port is ignored.
   */
  public allowHost(host: string): void {
    const trimmed = host.trim().toLowerCase();
    if (trimmed.length === 0) return;
    // Parse through a URL so a bare host, a host:port, and an IPv6 literal all
    // normalize the same way the candidate side will.
    const parsed = parse(`https://${trimmed}/`);
    if (parsed !== null) this.allowedHosts.add(parsed.hostname);
  }

  /** Number of distinct URLs recorded (diagnostics/tests). */
  public get size(): number {
    return this.urls.size;
  }

  /**
   * Seeds the trusted inputs for a run: the hosts the user allowlisted and the
   * URLs the user wrote in the goal. Both are trusted because the user supplied
   * them; everything else must be earned from a tool result.
   *
   * @param input - Allowed hosts and the raw (unsanitized) goal text.
   */
  public seed(input: { readonly allowedHosts?: readonly string[]; readonly goal?: string }): void {
    for (const host of input.allowedHosts ?? []) this.allowHost(host);
    for (const url of extractUrls(input.goal ?? '')) this.record(url);
  }
}

/** A URL reduced to its comparison form. */
interface ParsedUrl {
  readonly normalized: string;
  readonly origin: string;
  readonly originPath: string;
  readonly queryKeys: readonly string[];
  readonly isOriginRoot: boolean;
  /** Lowercased hostname without the port, for user host allowlisting. */
  readonly hostname: string;
}

/**
 * Reduces a URL to its comparison form, or `null` when it cannot be parsed.
 *
 * Scheme and host lowercase (both are case-insensitive per RFC 3986); the
 * fragment is dropped (it never reaches the server); one trailing slash is
 * stripped from a non-root path, so `/hotels` and `/hotels/` are one URL — the
 * exact mismatch that occurred in the logged run. Path and query case are
 * preserved: they are case-*sensitive*, and a differing query is precisely the
 * signal a fabricated deep link produces.
 */
function parse(url: string): ParsedUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.host.toLowerCase();
  const origin = `${scheme}//${host}/`;
  const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/u, '');
  const isOriginRoot = (path === '/' || path === '') && parsed.search === '';
  return {
    normalized: `${scheme}//${host}${path}${parsed.search}`,
    origin,
    originPath: `${scheme}//${host}${path}`,
    queryKeys: [...parsed.searchParams.keys()],
    isOriginRoot,
    hostname: parsed.hostname.toLowerCase(),
  };
}

/** Matches absolute http(s) URLs in free text, stopping at trailing punctuation. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/giu;

/** Extracts absolute URLs from free text (the user's own goal). */
function extractUrls(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).map((match) =>
    // Trailing sentence punctuation is not part of the URL.
    match.replace(/[.,;:!?)\]}]+$/u, ''),
  );
}
