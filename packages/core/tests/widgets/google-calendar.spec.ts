import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { fillField } from '../../src/fill/engine.js';
import { readCalendarGrid } from '../../src/widgets/date/calendar-grid.js';
import type { WidgetBudget, WidgetTarget } from '../../src/widgets/types.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

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
 * second fills check-out, neither is echoed into any single trigger, and Escape
 * closes the picker.
 *
 * The close matters as much as the commit. The captured markup is inert DOM, so
 * without it the popover can never go away, and a fill that correctly releases
 * the picker it drove would be judged against a page where releasing is
 * impossible.
 */
function installPairCommit(port: WidgetTestPort): void {
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
  const popup = port.document.querySelector<HTMLElement>('[role="grid"]')!;
  port.document.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') popup.style.display = 'none';
  });
}

/**
 * Model the captured widget's range protocol, which is what the markup alone
 * cannot express.
 *
 * Measured against the live page: the picker starts closed; opening it from a
 * field decides which end the next click fills; choosing one end clears the
 * other and the pair is held pending, visible in the fields but not yet the
 * page's; and closing keeps the pending pair only if it is complete and was
 * begun from the start field — anything else is discarded and the previous
 * range comes back. Opened from the end field the same two clicks select the
 * same two days and commit nothing, which is why a range has to be driven from
 * the opening end.
 */
function installRangePicker(
  port: WidgetTestPort,
  { startOpen = false }: { readonly startOpen?: boolean } = {},
): void {
  const from = port.document.querySelector<HTMLInputElement>('input[aria-label="Check-in"]')!;
  const to = port.document.querySelector<HTMLInputElement>('input[aria-label="Check-out"]')!;
  const popup = port.document.querySelector<HTMLElement>('[role="grid"]')!;
  popup.style.display = startOpen ? '' : 'none';

  let committed: readonly [string, string] = [from.value, to.value];
  let leading = from;
  let pending: string[] = [];

  const show = (starting: HTMLInputElement): void => {
    if (popup.style.display !== 'none') return;
    popup.style.display = '';
    leading = starting;
    pending = [];
  };
  for (const [field, other] of [
    [from, to],
    [to, from],
  ] as const) {
    field.addEventListener('click', () => {
      show(field);
      void other;
    });
  }

  for (const cell of port.document.querySelectorAll<HTMLElement>('[role="button"]')) {
    const label = cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
    const match = /^[A-Za-z]+day, ([A-Za-z]+) (\d{1,2}), \d{4}$/.exec(label);
    if (!match) continue;
    cell.addEventListener('click', () => {
      if (popup.style.display === 'none') return;
      if (pending.length >= 2) pending = [];
      pending.push(`${match[1]!.slice(0, 3)} ${match[2]}`);
      const [first, second] = [pending[0] ?? '', pending[1] ?? ''];
      if (leading === from) [from.value, to.value] = [first, second];
      else [to.value, from.value] = [first, second];
    });
  }

  port.document.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    popup.style.display = 'none';
    if (pending.length === 2 && leading === from) committed = [pending[0]!, pending[1]!];
    [from.value, to.value] = committed;
    pending = [];
  });
}

/** The pair the page is actually holding, ignoring anything still pending. */
function committedPair(port: WidgetTestPort): readonly string[] {
  return ['Check-in', 'Check-out'].map(
    (label) => port.document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.value,
  );
}

/** Whether the picker is still on screen. */
function pickerOpen(port: WidgetTestPort): boolean {
  return port.document.querySelector<HTMLElement>('[role="grid"]')!.style.display !== 'none';
}

describe('@no-llm google travel capture — grid reading', () => {
  it('reads every day cell despite an app-level aria-hidden ancestor', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    // The whole capture sits under aria-hidden="true"; before the fix this read
    // returned zero cells and reported only how many elements it had scanned.
    expect(read.cells.length).toBe(61);
    expect(read.displayedMonths).toEqual(['2026-08', '2026-09']);
  });

  it('derives each date from the label on the cell’s inert child', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    const september6 = read.cells.filter((cell) => cell.derivedDate === '2026-09-06');
    expect(september6).toHaveLength(1);
    expect(september6[0]!.derivation).toBe('aria-label');
    expect(september6[0]!.disabled).toBe(false);
  });

  it('still ignores a decorative label nested inside the cell itself', async () => {
    const port = new WidgetTestPort(popover);
    const cell = port.document.querySelector<HTMLElement>('[role="button"]')!;
    const decoy = cell.querySelector<HTMLElement>('[aria-hidden="true"]')!;
    decoy.setAttribute('aria-label', 'Friday, January 1, 2027');

    const read = await readCalendarGrid(port);

    // Scoping the guard to the cell must not disable it: a label under an
    // aria-hidden wrapper *within* the cell is still decorative.
    expect(read.cells.some((entry) => entry.derivedDate === '2027-01-01')).toBe(false);
  });

  it('treats an aria-hidden cell as unavailable even with no disabled attribute', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    // August 1-7 are out of range and the page says so only by removing them
    // from the accessibility tree.
    const august = read.cells.find((cell) => cell.derivedDate === '2026-08-03');
    expect(august?.disabled).toBe(true);
    const september = read.cells.find((cell) => cell.derivedDate === '2026-09-12');
    expect(september?.disabled).toBe(false);
  });

  it('never marks a label-derived cell unsafe, since no weekday was guessed', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    expect(read.cells.every((cell) => !cell.unsafe)).toBe(true);
  });
});

describe('@no-llm google travel capture — end to end', () => {
  it('commits a range that lands in the check-in/check-out pair, not the trigger', async () => {
    const port = new WidgetTestPort(popover);
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
    const port = new WidgetTestPort(popover);
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
    // No day was clicked. The trigger is clicked once, by the reopen that
    // re-tests a disabled opening date against a clean widget before believing
    // it — a range picker mid-selection greys out perfectly available days.
    expect(port.clickLog.filter((entry) => /^\d+$/.test(entry.name))).toEqual([]);
    expect(port.clickLog.map((entry) => entry.name)).toEqual(['Check-in']);
  });

  it('names the pair when half a range is asked of a picker that commits both', async () => {
    const port = new WidgetTestPort(popover);
    installRangePicker(port);
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    // The picker took the date and the release threw it away, which reads as an
    // uncooperative overlay and is really a request the widget cannot answer.
    // Reported as WIDGET_DISMISS_FAILED it sent the model off to open the
    // calendar and click cells itself; the fix is to say what to send instead.
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_RANGE_INCOMPLETE',
      details: { field: 'Check-in', partner: 'Check-out', requested: '2026-09-06' },
    });
    expect(outcome.ok ? '' : outcome.message).toContain('2026-09-06..<Check-out date>');
    // The page is left exactly as it was found — not half-changed.
    expect(committedPair(port)).toEqual(['Mon, Aug 10', 'Tue, Aug 11']);
  });

  it('commits the same widget when both ends arrive together', async () => {
    const port = new WidgetTestPort(popover);
    installRangePicker(port);
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-12' },
      BUDGET,
    );

    expect(outcome).toMatchObject({ ok: true, committed: 'Sep 6..Sep 12', dismissed: true });
    expect(committedPair(port)).toEqual(['Sep 6', 'Sep 12']);
  });

  it('releases a picker it drove even though it found it already open', async () => {
    const port = new WidgetTestPort(popover);
    installRangePicker(port, { startOpen: true });
    const ref = port.refFor('input[aria-label="Check-in"]');

    const outcome = await fillField(
      port,
      { field: 'Check-in', target: checkIn(ref) },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-12' },
      BUDGET,
    );

    // "Leave open whatever was open when I arrived" is right for a modal the
    // field sits inside and wrong for the picker being driven: this widget
    // holds the range in its own copy of the fields and writes it to the page
    // only on release, so skipping the release reported a committed range the
    // page had never seen.
    expect(outcome).toMatchObject({ ok: true, dismissed: true });
    expect(pickerOpen(port)).toBe(false);
    expect(committedPair(port)).toEqual(['Sep 6', 'Sep 12']);
  });

  it('opens a range from the start field even when the end field is addressed', async () => {
    const port = new WidgetTestPort(popover);
    installRangePicker(port);
    const ref = port.refFor('input[aria-label="Check-out"]');

    const outcome = await fillField(
      port,
      {
        field: 'Check-out',
        target: { ref, role: 'textbox', name: 'Check-out', group: null, value: 'Tue, Aug 11' },
      },
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-12' },
      BUDGET,
    );

    // Driven from the closing field this picker reads the first click as an end
    // and the second as the start of a fresh range, so it selected the right
    // two days and committed nothing at all.
    expect(outcome).toMatchObject({ ok: true, committed: 'Sep 6..Sep 12' });
    expect(committedPair(port)).toEqual(['Sep 6', 'Sep 12']);
  });

  it('does not release a picker the fill found open and never drove', async () => {
    const port = new WidgetTestPort('<div role="dialog"><input aria-label="Notes"></div>');
    const ref = port.refFor('input[aria-label="Notes"]');

    const outcome = await fillField(
      port,
      {
        field: 'Notes',
        target: { ref, role: 'textbox', name: 'Notes', group: null, value: '' },
      },
      { kind: 'text', text: 'a quiet note' },
      BUDGET,
    );

    // Only a container a driver operated is the fill's to close. A dialog the
    // field merely sits inside stays up.
    expect(outcome).toMatchObject({ ok: true, dismissed: false });
  });

  it('reports what it saw when a calendar genuinely has no day cells', async () => {
    const port = new WidgetTestPort(
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
