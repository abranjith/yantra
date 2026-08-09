import type { WidgetPort, WidgetTarget } from '../types.js';
import { readCommitted } from '../verify.js';

const FROM_NAME_RE = /\b(check[ -]?in|arrival|start date|depart(?:ure|ing)?)\b/i;
const TO_NAME_RE = /\b(check[ -]?out|return(?:ing)?|end date)\b/i;
const DATE_FIELD_ROLES = ['textbox', 'searchbox', 'combobox'];

/** The two controls a date range is spread across, when the page uses that shape. */
export interface DateFieldPair {
  readonly from: WidgetTarget;
  readonly to: WidgetTarget;
}

/**
 * Resolve the check-in/check-out pair a range field belongs to.
 *
 * Many sites spread one logical range over two controls rather than rendering
 * it into a single trigger. Both the typed-input driver (which fills each side)
 * and the calendar driver (which clicks two cells and must then verify what
 * landed) need the same pair, so the resolution lives here rather than in
 * either driver.
 *
 * Returns `null` unless exactly one control matches each side — an ambiguous
 * page is never guessed at.
 */
export async function resolveDatePair(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<DateFieldPair | null> {
  const observation = await port.observe({ cap: 400, trackDigest: false });
  const candidates = observation.interactables.filter((entry) =>
    DATE_FIELD_ROLES.includes(entry.role),
  );
  const scoped = target.group
    ? candidates.filter((entry) => (entry.group ?? null) === target.group)
    : candidates;
  const pool = scoped.length >= 2 ? scoped : candidates;
  const from = pool.filter((entry) => FROM_NAME_RE.test(entry.name));
  const to = pool.filter((entry) => TO_NAME_RE.test(entry.name));
  if (from.length !== 1 || to.length !== 1) return null;
  return { from: toTarget(from[0]!), to: toTarget(to[0]!) };
}

/**
 * The other end of the range when this field is half of a pair the page has
 * left unset, otherwise null.
 *
 * A picker that spreads one range over two controls commits the pair, not the
 * endpoint: choosing a start clears the end and the widget withholds the whole
 * selection until both are set, so releasing it there throws the choice away
 * and restores what was there before. Telling that apart from "the page
 * rejected this date" is the difference between an answer the caller can act on
 * and a dead end, and only the live page can distinguish them — hence the
 * partner is read rather than inferred from the shape of the request.
 */
export async function pendingRangePartner(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<WidgetTarget | null> {
  const pair = await resolveDatePair(port, target);
  if (!pair) return null;
  const partner = partnerOf(pair, target);
  if (!partner) return null;
  const committed = await readCommitted(port, partner);
  return committed.trim().length === 0 ? partner : null;
}

/**
 * Which half of the pair the target is not.
 *
 * Matched on the accessible name before the ref, because by this point the
 * drive has usually been re-bound to whichever copy of the control the open
 * popup mounted, and that copy carries a different ref than the pair just
 * observed while naming the same field.
 */
function partnerOf(pair: DateFieldPair, target: WidgetTarget): WidgetTarget | null {
  const name = target.name.trim().toLocaleLowerCase();
  if (target.ref === pair.from.ref || pair.from.name.trim().toLocaleLowerCase() === name) {
    return pair.to;
  }
  if (target.ref === pair.to.ref || pair.to.name.trim().toLocaleLowerCase() === name) {
    return pair.from;
  }
  return null;
}

function toTarget(entry: {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly group?: string;
  readonly value?: string;
}): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}
