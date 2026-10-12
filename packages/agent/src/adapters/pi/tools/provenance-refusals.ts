/**
 * The per-run count of URLs refused for missing provenance, shared by
 * `browser_navigate` and `web_fetch` (FEAT-051).
 *
 * Both tools refuse an unattested URL with `URL_NOT_FROM_EVIDENCE`; a second
 * refusal of the same normalized URL — by either tool — earns the "repeated"
 * wording, so a model alternating between the two tools on one guessed URL is
 * told it is repeating itself.
 */

import type { RunServices } from '../../../runtime/run-services.js';

const refusalCounts = new WeakMap<RunServices, Map<string, number>>();

/**
 * Count one refusal of `url` in this run.
 *
 * @param services - The run's services (the counter's scope).
 * @param url - The refused URL as the model supplied it.
 * @returns How many times this normalized URL has now been refused.
 */
export function recordProvenanceRefusal(services: RunServices, url: string): number {
  let perRun = refusalCounts.get(services);
  if (!perRun) {
    perRun = new Map();
    refusalCounts.set(services, perRun);
  }
  const normalized = normalizeRefusedUrl(url);
  const count = (perRun.get(normalized) ?? 0) + 1;
  perRun.set(normalized, count);
  return count;
}

function normalizeRefusedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    url.searchParams.sort();
    return url.toString();
  } catch {
    // swallow-ok: URL parse helper; an unparseable value is compared as text
    return value.trim();
  }
}
