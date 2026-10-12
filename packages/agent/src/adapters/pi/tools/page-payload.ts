/**
 * The model-visible view of a shape-aware page read (FEAT-051), and the URL
 * provenance it earns.
 *
 * A page read now offers links, record URLs, and structured URL properties,
 * and each becomes navigable because the page attested it (G3). Two rules keep
 * that safe:
 *
 * - **Offer only what survives intact.** A URL is offered only when the
 *   middleware's model-visible transform (user-input mask, then the `public`
 *   sanitizer) leaves it byte-identical, so the URL the model copies is
 *   exactly the URL that was recorded. Anything else is withheld (`url: null`)
 *   and counted.
 * - **Record only what was shown.** {@link recordDiscovered} walks the payload
 *   the model will actually read, so a link trimmed by a bound is never
 *   attested until a later view shows it.
 */

import type { LinkKind } from '@yantra/core';

import { modelVisibleText } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { extractUrls, type ProvenanceOrigin } from '../../../runtime/url-provenance.js';

/** The services a payload check needs: exactly the model-visible transform's inputs. */
export type PayloadServices = Pick<RunServices, 'userInput' | 'modelValues' | 'sanitizer'>;

/**
 * Whether a URL reaches the model byte-identical. The URL is checked as a JSON
 * string, the form it takes inside a tool payload, so an escape or redaction
 * that only happens in that context is caught too.
 *
 * @param url - An absolute URL the page offers.
 * @param services - The run's sanitizer and user-input vault.
 */
export function offerableUrl(url: string, services: PayloadServices): boolean {
  const serialized = JSON.stringify([url]);
  return modelVisibleText([url], 'public', services).text === serialized;
}

/** The URL-bearing members of a page payload, in its wire form. */
export interface DiscoverablePayload {
  readonly links?: readonly { readonly url: string | null; readonly kind?: string }[];
  readonly records?: readonly {
    readonly url?: string | null;
    readonly links?: readonly { readonly url: string | null }[];
  }[];
  readonly structured?: readonly { readonly props: Readonly<Record<string, unknown>> }[];
  readonly text?: string;
  readonly excerpt?: string;
}

const LINK_KINDS: ReadonlySet<string> = new Set([
  'pagination',
  'facet',
  'record',
  'content',
  'navigation',
]);

/**
 * Records, as `discovered` from `sourceId`, every URL the payload shows the
 * model: offered links (with their kind), record URLs and record links,
 * absolute http(s) structured properties, and URLs written in returned text.
 * Withheld (`null`) URLs and URLs that would not survive the model-visible
 * transform are skipped, so nothing the model was not shown is attested.
 *
 * @param services - The run services (provenance plus the transform's inputs).
 * @param sourceId - The evidence ID of the page that offered the URLs.
 * @param payload - The projected payload, exactly as the model will read it.
 * @returns The number of URLs recorded.
 */
export function recordDiscovered(
  services: PayloadServices & Pick<RunServices, 'urlProvenance'>,
  sourceId: string,
  payload: DiscoverablePayload,
): number {
  let recorded = 0;
  const record = (
    url: string | null | undefined,
    linkKind: LinkKind | 'text' | 'structured',
  ): void => {
    // A whole value that is one absolute http(s) URL, never a URL-led sentence.
    if (typeof url !== 'string' || !/^https?:\/\/\S+$/iu.test(url)) return;
    if (!offerableUrl(url, services)) return;
    const origin: ProvenanceOrigin = { kind: 'discovered', sourceId, linkKind };
    services.urlProvenance.record(url, origin);
    recorded += 1;
  };
  for (const link of payload.links ?? []) {
    const kind =
      link.kind !== undefined && LINK_KINDS.has(link.kind) ? (link.kind as LinkKind) : 'content';
    record(link.url, kind);
  }
  for (const entry of payload.records ?? []) {
    record(entry.url, 'record');
    for (const link of entry.links ?? []) record(link.url, 'content');
  }
  for (const entity of payload.structured ?? []) {
    for (const value of Object.values(entity.props)) {
      if (typeof value === 'string') record(value.trim(), 'structured');
    }
  }
  for (const text of [payload.text, payload.excerpt]) {
    for (const url of extractUrls(text ?? '')) record(url, 'text');
  }
  return recorded;
}
