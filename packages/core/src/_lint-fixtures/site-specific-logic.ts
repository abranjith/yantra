/**
 * Lint fixture: website-specific logic, which the no-restricted-syntax rule
 * must reject. Loaded only by `tests/boundary-rules.spec.ts`.
 *
 * The comment below deliberately names a site and must NOT trip the rule —
 * naming the site that demonstrated a general defect is evidence, not logic.
 * The KAYAK date trigger is what motivated reading a committed value from
 * every surface a control offers.
 */
export function pickStrategy(host: string): string {
  if (host === 'www.expedia.com') return 'legacy';
  return `${host} on booking.com`;
}
