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
 *
 * Since FEAT-051 every recording carries its {@link ProvenanceOrigin}, and
 * {@link UrlProvenance.explain} reports which rule admitted a URL and which
 * recording granted it, so the audit can reconstruct a chain of discovered
 * links hop by hop.
 */

import type { LinkKind } from '@yantra/core';

/**
 * How a URL earned its attestation (FEAT-051). The first origin recorded for a
 * normalized URL wins, so the audit always names the earliest attestation.
 *
 * - `goal`: the user wrote the URL in the goal.
 * - `allow-host`: the user allowlisted the host (`--allow-host`).
 * - `tool`: a tool result produced it (a search result, a fetched page, a
 *   browser action's landing URL).
 * - `discovered`: a page this run read offered it — as a link, a record, a
 *   structured property, or a URL written in its text. `sourceId` names that
 *   page, so every hop of a discovered chain is visible in the audit.
 */
export type ProvenanceOrigin =
  | { readonly kind: 'goal' }
  | { readonly kind: 'allow-host' }
  | { readonly kind: 'tool'; readonly tool: string }
  | {
      readonly kind: 'discovered';
      readonly sourceId: string;
      readonly linkKind: LinkKind | 'text' | 'structured';
    };

/** Which rule admitted a URL. */
export type ProvenanceMatch = 'exact' | 'origin-root' | 'query-variant' | 'allowed-host';

/** Why a URL is attested: the matching rule and the origin of the recording that granted it. */
export interface ProvenanceExplanation {
  readonly match: ProvenanceMatch;
  readonly origin: ProvenanceOrigin;
}

/**
 * Append-only set of URLs this run may navigate to.
 *
 * Seeded from the trusted inputs (`--allow-host` entries and URLs in the raw
 * goal), then extended by every tool that returns a URL.
 */
export class UrlProvenance {
  /** Normalized URLs seen this run, each with the origin that first recorded it. */
  private readonly urls = new Map<string, ProvenanceOrigin>();
  /** Normalized origin roots (`https://host/`) of every recorded URL, with the first origin. */
  private readonly origins = new Map<string, ProvenanceOrigin>();
  /** Query parameter names attested for each normalized origin + path. */
  private readonly queryKeysByOriginPath = new Map<string, Set<string>>();
  /** The first origin recorded for each normalized origin + path. */
  private readonly originByOriginPath = new Map<string, ProvenanceOrigin>();
  /** Hostnames the user explicitly allowlisted; see {@link allowHost}. */
  private readonly allowedHosts = new Set<string>();

  /**
   * Records a URL and how it was attested. Unparseable input is ignored rather
   * than thrown: provenance is a permission record, and a malformed string
   * simply grants nothing. The first origin for a normalized URL wins.
   *
   * @param url - The URL as the tool reported it.
   * @param origin - How the URL was attested.
   */
  public record(url: string, origin: ProvenanceOrigin): void {
    const parsed = parse(url);
    if (parsed === null) return;
    if (!this.urls.has(parsed.normalized)) this.urls.set(parsed.normalized, origin);
    if (!this.origins.has(parsed.origin)) this.origins.set(parsed.origin, origin);
    if (!this.originByOriginPath.has(parsed.originPath)) {
      this.originByOriginPath.set(parsed.originPath, origin);
    }
    const keys = this.queryKeysByOriginPath.get(parsed.originPath) ?? new Set<string>();
    for (const key of parsed.queryKeys) keys.add(key);
    this.queryKeysByOriginPath.set(parsed.originPath, keys);
  }

  /**
   * Why this run may navigate to `url`, or null when it may not.
   *
   * Admits, in order: a user-allowlisted host; a normalized exact match; the
   * bare origin of any recorded URL (backing out to a site's root is always
   * reachable by clicking its logo, so refusing it would be a false positive
   * with no safety value); and a recorded origin + path whose every query
   * parameter name was attested, values free to vary. For a non-exact match the
   * origin is the one recorded first for that origin root or path.
   *
   * @param url - The candidate navigation target.
   */
  public explain(url: string): ProvenanceExplanation | null {
    const parsed = parse(url);
    if (parsed === null) return null;
    if (this.allowedHosts.has(parsed.hostname)) {
      return { match: 'allowed-host', origin: { kind: 'allow-host' } };
    }
    const exact = this.urls.get(parsed.normalized);
    if (exact !== undefined) return { match: 'exact', origin: exact };
    const root = parsed.isOriginRoot ? this.origins.get(parsed.origin) : undefined;
    if (root !== undefined) return { match: 'origin-root', origin: root };
    const knownKeys = this.queryKeysByOriginPath.get(parsed.originPath);
    const granting = this.originByOriginPath.get(parsed.originPath);
    if (
      knownKeys !== undefined &&
      granting !== undefined &&
      parsed.queryKeys.every((key) => knownKeys.has(key))
    ) {
      return { match: 'query-variant', origin: granting };
    }
    return null;
  }

  /**
   * Whether this run may navigate to `url`: exactly {@link explain} returning
   * an explanation, so the decision and its explanation cannot diverge.
   *
   * @param url - The candidate navigation target.
   */
  public has(url: string): boolean {
    return this.explain(url) !== null;
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
   * Seeds the trusted inputs for a run: the hosts the user allowlisted, the
   * URLs the user wrote in the goal, and the origin roots of hostnames the
   * user wrote bare ("Use example.com"). All are trusted because the user
   * supplied them; everything else must be earned from a tool result.
   *
   * A bare hostname attests only `https://<host>/` and `http://<host>/` — no
   * path and no `www.` variant. That is the same statement a typed URL makes,
   * at the one place every site is reachable from (FEAT-052). A false positive
   * such as `node.js` grants a root navigation that simply fails, and the URL
   * policy, ethics gate, and host budget still apply.
   *
   * Only the user's raw goal is read here. A model-declared task contract's
   * `required_sources` is never a seed: model text attests nothing.
   *
   * @param input - Allowed hosts and the raw (unsanitized) goal text.
   */
  public seed(input: { readonly allowedHosts?: readonly string[]; readonly goal?: string }): void {
    for (const host of input.allowedHosts ?? []) this.allowHost(host);
    const goal = input.goal ?? '';
    for (const url of extractUrls(goal)) this.record(url, { kind: 'goal' });
    for (const host of extractBareHosts(goal)) {
      this.record(`https://${host}/`, { kind: 'goal' });
      this.record(`http://${host}/`, { kind: 'goal' });
    }
  }
}

/**
 * The audit projection of an explanation (`details.provenance` on `web_fetch`
 * and `browser_navigate`): the match rule, the origin kind, and — for a
 * discovered URL — the containing source and link kind. Never page text.
 *
 * @param explanation - The explanation, or null for an unattested URL.
 */
export function provenanceDetails(
  explanation: ProvenanceExplanation | null,
): Readonly<Record<string, string>> {
  if (explanation === null) return { match: 'none', kind: 'none' };
  const { match, origin } = explanation;
  switch (origin.kind) {
    case 'discovered':
      return { match, kind: origin.kind, via: origin.sourceId, link_kind: origin.linkKind };
    case 'tool':
      return { match, kind: origin.kind, tool: origin.tool };
    case 'goal':
    case 'allow-host':
      return { match, kind: origin.kind };
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

/**
 * Extracts absolute URLs from free text: the user's goal, and the URLs a page
 * read shows the model in its returned text (one grammar for both).
 *
 * @param text - Free text.
 */
export function extractUrls(text: string): string[] {
  return (text.match(URL_IN_TEXT) ?? []).map((match) =>
    // Trailing sentence punctuation is not part of the URL.
    match.replace(/[.,;:!?)\]}]+$/u, ''),
  );
}

/**
 * A hostname written without a scheme. The lookbehind refuses a token glued
 * to a word, `@` (so an email address attests nothing), `.`, `/`, or `-`; the
 * lookahead refuses one that continues into a word, `@`, or `-`.
 */
const BARE_HOST_IN_TEXT =
  /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w@-])/giu;

/**
 * Extracts lowercased hostnames the text names without a scheme, ignoring any
 * that are part of an absolute URL (those are attested by
 * {@link extractUrls} exactly as written).
 *
 * @param text - Free text (the user's goal).
 */
export function extractBareHosts(text: string): string[] {
  const withoutUrls = text.replace(URL_IN_TEXT, ' ');
  const hosts = (withoutUrls.match(BARE_HOST_IN_TEXT) ?? []).map((host) => host.toLowerCase());
  return [...new Set(hosts)];
}
