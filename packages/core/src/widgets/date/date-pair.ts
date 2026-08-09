import type { WidgetPort, WidgetTarget } from '../types.js';

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
