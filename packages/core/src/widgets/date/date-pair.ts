import type { WidgetPort, WidgetTarget } from '../types.js';
import { readCommitted } from '../verify.js';

const FROM_NAME_RE = /\b(check[ -]?in|arrival|start date|depart(?:ure|ing)?)\b/i;
const TO_NAME_RE = /\b(check[ -]?out|return(?:ing)?|end date)\b/i;
/**
 * Roles a half of a date pair is allowed to have.
 *
 * `button` earns its place because that is what a compact picker's two ends
 * usually are — KAYAK's "Select start date from calendar input" is a
 * `div[role=button]`, not a text box, and excluding it meant every paired
 * range on such a site was driven and verified as if it were a lone date.
 * Breadth here is safe: the pair is still accepted only when the page's own
 * labelling matches exactly one control per side.
 */
const DATE_FIELD_ROLES = ['textbox', 'searchbox', 'combobox', 'button'];

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
  const from = await withoutDayCells(
    port,
    pool.filter((entry) => FROM_NAME_RE.test(entry.name)),
  );
  const to = await withoutDayCells(
    port,
    pool.filter((entry) => TO_NAME_RE.test(entry.name)),
  );
  if (from.length !== 1 || to.length !== 1) return null;
  return { from: toTarget(from[0]!), to: toTarget(to[0]!) };
}

/**
 * Drop the calendar's own day cells from a list of candidate range ends.
 *
 * An open picker labels its chosen days "August 13, 2026. Selected as start
 * date", which reads as the start of a range to any name-based test — and being
 * `role="button"`, exactly like the field that opened it, no role test tells
 * them apart either. Mistaking one for the field is not a near miss: the engine
 * re-points a range drive at the pair's opening end, so the whole fill is then
 * driven from a day cell, which opens nothing. Where the control *sits* is the
 * fact that separates them — a date field is never inside the grid it opens.
 */
async function withoutDayCells<T extends { readonly ref: string }>(
  port: WidgetPort,
  candidates: readonly T[],
): Promise<readonly T[]> {
  const kept: T[] = [];
  for (const candidate of candidates) {
    // `[role=grid]`/`[role=listbox]` and not a bare `<table>`: a legacy
    // table-laid-out form holds real fields, an ARIA grid holds cells.
    const inGrid = await port.evaluateOn(
      candidate.ref,
      (element) => element.closest('[role="grid"],[role="listbox"]') !== null,
    );
    if (!inGrid) kept.push(candidate);
  }
  return kept;
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
