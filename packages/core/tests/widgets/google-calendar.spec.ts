import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fillField } from '../../src/fill/engine.js';
import { readCalendarGrid } from '../../src/widgets/date/calendar-grid.js';
import type { WidgetBudget, WidgetTarget } from '../../src/widgets/types.js';

import { CalendarTestPort } from './calendar-test-port.js';

/**
 * Regression suite for run 20260809T024548Z-do-4a2225cc, driven by a verbatim
 * capture of Google Travel's date picker.
 *
 * That run reported `WIDGET_TARGET_UNREACHABLE` four times with the same
 * diagnostic — "the calendar container is open, 2661 elements were scanned, and
 * 0 day cells were recognized" — while the observation shown to the model in the
 * same breath listed day cells named "Saturday, September 5, 2026". Every cell
 * on the page was readable and none was read.
 *
 * Three properties of this capture are what the hand-built fixtures could not
 * express, and each one alone defeated the reader:
 *
 *  1. an app-level ancestor carries `aria-hidden="true"`, and the guard meant to
 *     skip decorative labels *inside* a cell walked up into it;
 *  2. out-of-range days are marked with `aria-hidden="true"` on the cell and
 *     with no `aria-disabled` or `disabled` of any kind;
 *  3. panels are captioned "August"/"September" with no year, so nothing
 *     structural is parseable and the date must come from the cell's label.
 */
const popover = readFileSync(
  new URL('../fixtures/google-travel-date-popover.html', import.meta.url),
  'utf8',
);

const BUDGET: WidgetBudget = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxPagingSteps: 12,
  maxActions: 24,
};

const checkIn = (ref: string): WidgetTarget => ({
  ref,
  role: 'textbox',
  name: 'Check-in',
  group: null,
  value: 'Mon, Aug 10',
});

/**
 * Commit the way the real page does: the first day click fills check-in, the
 * second fills check-out, and neither is echoed into any single trigger.
 */
function installPairCommit(port: CalendarTestPort): void {
  const from = port.document.querySelector<HTMLInputElement>('input[aria-label="Check-in"]')!;
  const to = port.document.querySelector<HTMLInputElement>('input[aria-label="Check-out"]')!;
  let clicks = 0;
  for (const cell of port.document.querySelectorAll<HTMLElement>('[role="button"]')) {
    const label = cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
    const match = /^[A-Za-z]+day, ([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(label);
    if (!match) continue;
    cell.addEventListener('click', () => {
      const rendered = `${match[1]!.slice(0, 3)} ${match[2]}`;
      clicks += 1;
      if (clicks === 1) from.value = rendered;
      else to.value = rendered;
    });
  }
}

describe('@no-llm google travel capture — grid reading', () => {
  it('reads every day cell despite an app-level aria-hidden ancestor', async () => {
    const port = new CalendarTestPort(popover);

    const read = await readCalendarGrid(port);

    // The whole capture sits under aria-hidden="true"; before the fix this read
    // returned zero cells and reported only how many elements it had scanned.
    expect(read.cells.length).toBe(61);
    expect(read.displayedMonths).toEqual(['2026-08', '2026-09']);
  });

  it('derives each date from the label on the cell’s inert child', async () => {
    const port = new CalendarTestPort(popover);

    const read = await readCalendarGrid(port);

    const september6 = read.cells.filter((cell) => cell.derivedDate === '2026-09-06');
    expect(september6).toHaveLength(1);
    expect(september6[0]!.derivation).toBe('aria-label');
    expect(september6[0]!.disabled).toBe(false);
  });

  it('still ignores a decorative label nested inside the cell itself', async () => {
    const port = new CalendarTestPort(popover);
    const cell = port.document.querySelector<HTMLElement>('[role="button"]')!;
    const decoy = cell.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    decoy.setAttribute('aria-label', 'Friday, January 1, 2027');

    const read = await readCalendarGrid(port);

    // Scoping the guard to the cell must not disable it: a label under an
    // aria-hidden wrapper *within* the cell is still decorative.
    expect(read.cells.some((entry) => entry.derivedDate === '2027-01-01')).toBe(false);
  });

  it('treats an aria-hidden cell as unavailable even with no disabled attribute', async () => {
    const port = new CalendarTestPort(popover);

    const read = await readCalendarGrid(port);

    // August 1-7 are out of range and the page says so only by removing them
    // from the accessibility tree.
    const august = read.cells.find((cell) => cell.derivedDate === '2026-08-03');
    expect(august?.disabled).toBe(true);
    const september = read.cells.find((cell) => cell.derivedDate === '2026-09-12');
    expect(september?.disabled).toBe(false);
  });

  it('never marks a label-derived cell unsafe, since no weekday was guessed', async () => {
    const port = new CalendarTestPort(popover);

    const read = await readCalendarGrid(port);

    expect(read.cells.every((cell) => !cell.unsafe)).toBe(true);
  });
});

describe('@no-llm google travel capture — end to end', () => {
  it('commits a range that lands in the check-in/check-out pair, not the trigger', async () => {
    const port = new CalendarTestPort(popover);
    installPairCommit(port);
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-12' },
      BUDGET,
    );

    // Both panels hold a cell numbered 6 and one numbered 12, so the day text
    // alone proves nothing; the committed value carries the month each clicked
    // cell actually declared. The trigger holds only its own endpoint and
    // renders no year, and verifying it alone called this selection
    // uncommitted.
    expect(outcome).toMatchObject({ ok: true, committed: 'Sep 6..Sep 12' });
    expect(port.clickLog.map((entry) => entry.name)).toEqual(['6', '12']);
  });

  it('refuses an out-of-range date instead of clicking an inert cell', async () => {
    const port = new CalendarTestPort(popover);
    installPairCommit(port);
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date', date: '2026-08-03' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { reason: 'disabled' },
    });
    expect(port.clickLog).toEqual([]);
  });

  it('reports what it saw when a calendar genuinely has no day cells', async () => {
    const port = new CalendarTestPort(
      '<input aria-label="Check-in" aria-controls="cal" value="Mon, Aug 10">' +
        '<div id="cal" role="grid"><div role="row"><div role="gridcell">Flexible</div></div></div>',
    );
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { reason: 'empty_calendar', cellsSeen: 0 },
    });
  });
});
