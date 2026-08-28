import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { calendarDriver } from '../../src/widgets/date/calendar-driver.js';
import { readCalendarGrid } from '../../src/widgets/date/calendar-grid.js';
import { isOpen, openIfClosed, resolveContainer } from '../../src/widgets/open-state.js';
import type { WidgetBudget, WidgetTarget } from '../../src/widgets/types.js';
import { WidgetTestPort } from '../support/widget-test-port.js';

/**
 * Regression suite for run 20260808T015833Z-do-2f43c685, driven by the verbatim
 * page capture rather than a synthetic grid. Every assertion here failed before
 * the fix, and none of them could fail against the hand-built fixtures: those
 * gave each table a `<caption>` and each day cell a bare-number label, which is
 * precisely the shape the real page does not have.
 */
const popover = readFileSync(
  new URL('../fixtures/expedia-date-popover.html', import.meta.url),
  'utf8',
);

const target = (ref: string): WidgetTarget => ({
  ref,
  role: 'button',
  name: 'Dates, Fri, Aug 21 - Sat, Aug 22',
  group: null,
  value: null,
});

/** The trigger as the real page ships it: aria-expanded stuck at "false". */
const withStuckTrigger = (extra = ''): string =>
  `<div><button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22" aria-expanded="false" ` +
  `aria-haspopup="dialog">Dates</button>${extra}</div>${popover}`;

describe('@no-llm real calendar capture — grid reading', () => {
  it('reads every day cell from a grid with no caption and no machine-readable dates', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    expect(read.cells.length).toBe(61);
    expect(read.displayedMonths).toEqual(['2026-08', '2026-09']);
  });

  it('derives each date from the label on the cell’s inert child, not the bare number', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    const september6 = read.cells.filter((cell) => cell.derivedDate === '2026-09-06');
    expect(september6).toHaveLength(1);
    expect(september6[0]!.derivation).toBe('aria-label');
    expect(september6[0]!.disabled).toBe(false);
  });

  it('separates the two panels’ identically numbered cells', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    // "6" appears in both August and September; they must resolve to different dates.
    const sixes = read.cells.filter((cell) => cell.day === 6);
    expect(sixes.map((cell) => cell.derivedDate).sort()).toEqual(['2026-08-06', '2026-09-06']);
    expect(new Set(read.cells.map((cell) => cell.derivedDate)).size).toBe(read.cells.length);
  });

  it('marks past days disabled and future days selectable', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    const byDate = new Map(read.cells.map((cell) => [cell.derivedDate, cell]));
    expect(byDate.get('2026-08-06')!.disabled).toBe(true);
    expect(byDate.get('2026-08-08')!.disabled).toBe(false);
  });

  it('labels each panel from the bare <span> month caption', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    expect(read.cells.find((cell) => cell.derivedDate === '2026-08-08')!.monthLabel).toBe(
      'August 2026',
    );
    expect(read.cells.find((cell) => cell.derivedDate === '2026-09-06')!.monthLabel).toBe(
      'September 2026',
    );
  });

  it('never marks a label-derived cell unsafe, since no weekday guess was made', async () => {
    const port = new WidgetTestPort(popover);

    const read = await readCalendarGrid(port);

    expect(read.cells.filter((cell) => cell.unsafe)).toEqual([]);
  });
});

describe('@no-llm real calendar capture — open state', () => {
  it('finds the open popover even though it has no id for aria-controls', async () => {
    const port = new WidgetTestPort(withStuckTrigger());
    const ref = port.refFor('button[aria-label^="Dates"]');

    const container = await resolveContainer(port, target(ref), { allowUnlinked: true });

    expect(container).not.toBeNull();
  });

  it('reports an on-screen popover open despite aria-expanded="false"', async () => {
    const port = new WidgetTestPort(withStuckTrigger());
    const ref = port.refFor('button[aria-label^="Dates"]');
    const container = await resolveContainer(port, target(ref), { allowUnlinked: true });

    await expect(isOpen(port, target(ref), container!)).resolves.toBe(true);
  });

  // Detection runs against every field of a form, including plain text inputs.
  // Letting it claim an unrelated open dialog is how a search box gets driven
  // as a calendar, so the loose scan stays off unless a caller opts in.
  it('does not hand an undeclared popover to a caller that did not opt in', async () => {
    const port = new WidgetTestPort(
      `<input aria-label="Search"><button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22">Dates</button>${popover}`,
    );
    const searchRef = port.refFor('input[aria-label="Search"]');
    const search: WidgetTarget = {
      ref: searchRef,
      role: 'textbox',
      name: 'Search',
      group: null,
      value: null,
    };

    await expect(resolveContainer(port, search)).resolves.toBeNull();
    await expect(calendarDriver.detect(port, search)).resolves.toBe(0);
  });

  it('does not click a widget that is already open', async () => {
    const port = new WidgetTestPort(withStuckTrigger());
    const ref = port.refFor('button[aria-label^="Dates"]');

    const opened = await openIfClosed(port, target(ref));

    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.wasOpen).toBe(true);
    expect(port.clickLog).toEqual([]);
  });

  it('refuses to guess when a second popover is open and nothing declares the link', async () => {
    // No aria-controls, aria-owns, or aria-haspopup: only the last-resort scan
    // applies, and two candidates must resolve to none rather than a coin flip.
    const port = new WidgetTestPort(
      `<div><button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22">Dates</button></div>` +
        `${popover}<div role="listbox"><button>other</button></div>`,
    );
    const ref = port.refFor('button[aria-label^="Dates"]');

    await expect(resolveContainer(port, target(ref), { allowUnlinked: true })).resolves.toBeNull();
  });

  it('still resolves the lone popover when the trigger declares nothing', async () => {
    const port = new WidgetTestPort(
      `<div><button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22">Dates</button></div>${popover}`,
    );
    const ref = port.refFor('button[aria-label^="Dates"]');

    await expect(
      resolveContainer(port, target(ref), { allowUnlinked: true }),
    ).resolves.not.toBeNull();
  });
});

const BUDGET: WidgetBudget = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxPagingSteps: 12,
  maxActions: 24,
};

/** Echo each picked day back onto the trigger, the way the live page does. */
function installCommit(port: WidgetTestPort): void {
  const trigger = port.document.querySelector<HTMLElement>('button[aria-label^="Dates"]')!;
  const picked: string[] = [];
  for (const cell of port.document.querySelectorAll<HTMLElement>(
    '[role="button"].uitk-day-button',
  )) {
    cell.addEventListener('click', () => {
      const label = cell.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
      picked.push(label.replace(/^[A-Za-z]+,\s*/, '').replace(/,.*$/, ''));
      trigger.setAttribute('aria-label', `Dates, ${picked.slice(-2).join(' - ')}`);
    });
  }
}

/**
 * Regression suite for run 20260808T030747Z-do-8bb2bb1f, where the open-state
 * fix landed but the driver still reported `WIDGET_TARGET_UNREACHABLE` with
 * `displayedMonths: []`. The popover carries an empty tabpanel placeholder,
 * `<div id="date_form_nested_flexible_tab_calendar"></div>`, alongside the real
 * content; resolving `aria-controls` to it scoped every grid read to an empty
 * subtree while the unscoped observation saw all 61 cells.
 */
describe('@no-llm real calendar capture — container resolution', () => {
  const withPlaceholderTrigger = (): string =>
    `<button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22" aria-expanded="false" ` +
    `aria-controls="date_form_nested_flexible_tab_calendar">Dates</button>${popover}`;

  it('skips an empty aria-controls placeholder and finds the real popover', async () => {
    const port = new WidgetTestPort(withPlaceholderTrigger());
    const ref = port.refFor('button[aria-label^="Dates"]');

    const container = await resolveContainer(port, target(ref), { allowUnlinked: true });
    const read = await readCalendarGrid(port, container ?? undefined);

    expect(read.cells).toHaveLength(61);
    expect(read.displayedMonths).toEqual(['2026-08', '2026-09']);
  });

  it('does not call an empty zero-height element an open container', async () => {
    const port = new WidgetTestPort(
      `<button aria-label="Dates" aria-expanded="false" aria-controls="empty">Dates</button>` +
        `<div id="empty"></div>`,
    );
    const ref = port.refFor('button[aria-label="Dates"]');
    const empty = { path: [1, 1] as readonly number[] };

    await expect(isOpen(port, target(ref), empty)).resolves.toBe(false);
  });

  it('widens to the document when the resolved container holds no day cells', async () => {
    // A non-empty but wrong container: it survives the placeholder check, so
    // only the driver's own "no cells means wrong scope" retry can save it.
    const port = new WidgetTestPort(
      `<button aria-label="Dates, Fri, Aug 21 - Sat, Aug 22" aria-expanded="false" ` +
        `aria-controls="decoy">Dates</button>` +
        `<div id="decoy"><span>Flexible dates</span></div>${popover}`,
    );
    installCommit(port);
    const ref = port.refFor('button[aria-label^="Dates"]');

    const container = await resolveContainer(port, target(ref), { allowUnlinked: true });
    await expect(readCalendarGrid(port, container ?? undefined)).resolves.toMatchObject({
      cells: [],
    });

    const outcome = await calendarDriver.drive(
      port,
      target(ref),
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-12' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: true,
      committed: 'Dates, September 6 - September 12',
    });
  });
});

describe('@no-llm real calendar capture — end to end', () => {
  it('picks a September range from the already-open popover in two clicks', async () => {
    const port = new WidgetTestPort(withStuckTrigger());
    installCommit(port);
    const ref = port.refFor('button[aria-label^="Dates"]');

    const outcome = await calendarDriver.drive(
      port,
      target(ref),
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-08' },
      BUDGET,
    );

    // The committed value is the load-bearing assertion: both panels hold a
    // cell numbered 6 and one numbered 8, so only the dates the trigger echoes
    // back prove the September cells were the ones clicked.
    expect(outcome).toMatchObject({
      ok: true,
      driver: 'calendar-grid',
      committed: 'Dates, September 6 - September 8',
    });
    // Two day clicks and nothing else: no click on the trigger, which is what
    // shut the calendar in the run this suite reproduces.
    expect(port.clickLog).toHaveLength(2);
    expect(port.clickLog.map((entry) => entry.name)).toEqual(['6', '8']);
  });

  it('refuses a past date instead of clicking a disabled cell', async () => {
    const port = new WidgetTestPort(withStuckTrigger());
    installCommit(port);
    const ref = port.refFor('button[aria-label^="Dates"]');

    const outcome = await calendarDriver.drive(
      port,
      target(ref),
      { kind: 'date', date: '2026-08-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { reason: 'disabled' },
    });
    expect(port.clickLog).toEqual([]);
  });
});
