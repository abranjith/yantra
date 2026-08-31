import type { InteractionFailureCause } from '../../interaction/index.js';
import { isOpen, openIfClosed, resolveContainer, type WidgetContainer } from '../open-state.js';
import { clickCandidate } from '../option/candidates.js';
import {
  widgetFailure,
  type WidgetDriver,
  type WidgetFailure,
  type WidgetPort,
  type WidgetTarget,
} from '../types.js';
import { matchesIntent, readCommitted } from '../verify.js';

import { readCalendarGrid, type CalendarGridRead } from './calendar-grid.js';
import { resolveDatePair } from './date-pair.js';

interface ClickDateSuccess {
  readonly ok: true;
  readonly actions: number;
  readonly read: CalendarGridRead;
}

type ClickDateResult = ClickDateSuccess | (WidgetFailure & { readonly read: CalendarGridRead });

/** Driver for popup calendars rendered as table/grid or labelled day cells. */
export const calendarDriver: WidgetDriver = {
  kind: 'calendar-grid',
  family: 'date',
  detect: async (port, target) => {
    const signal = await port.evaluateOn(target.ref, (element) => {
      const rendered =
        element instanceof HTMLInputElement
          ? element.value
          : (element.getAttribute('aria-label') ?? element.textContent ?? '');
      const popup = element.getAttribute('aria-haspopup')?.toLowerCase() ?? '';
      return {
        renderedDate:
          /\b\d{4}-\d{2}-\d{2}\b/.test(rendered) ||
          /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(rendered),
        popup,
      };
    });
    if (signal.popup === 'dialog' || signal.popup === 'grid') return 0.95;
    if (signal.renderedDate) return 0.85;
    const container = await resolveContainer(port, target);
    if (!container) return 0;
    return port.evaluate((path) => {
      let current: Element | null = document.documentElement;
      for (const index of path) current = current?.children.item(index) ?? null;
      return current?.querySelector('table,[role="grid"],[aria-label]') ? 0.75 : 0;
    }, container.path);
  },
  /**
   * What an opened container says about itself.
   *
   * A month grid is unmistakable once it is on the page — a table or a
   * `role="grid"`, or a run of day-shaped cells — and that is precisely the
   * evidence a closed trigger withholds. Reached only from the engine's open
   * probe, which knows the container came from its own click.
   */
  detectOpen: async (port, _target, container) =>
    port.evaluate((path) => {
      let current: Element | null = document.documentElement;
      for (const index of path) current = current?.children.item(index) ?? null;
      if (!(current instanceof HTMLElement)) return 0;
      if (current.querySelector('table,[role="grid"],[role="rowgroup"]')) return 0.9;
      const cells = Array.from(current.querySelectorAll('[role="gridcell"],td,button'));
      const dayShaped = cells.filter((cell) =>
        /^\s*\d{1,2}\s*$/.test(cell.textContent ?? ''),
      ).length;
      // A week's worth of bare day numbers is a calendar; two or three is a
      // pager, a rating, or a list of quantities.
      return dayShaped >= 7 ? 0.8 : 0;
    }, container.path),
  drive: async (port, target, intent, budget) => {
    if (intent.kind !== 'date' && intent.kind !== 'date_range') {
      return calendarFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'intent-incompatible',
        'A calendar accepts only date intents.',
        emptyRead(),
      );
    }

    // This is the sole trigger-open decision for the entire drive. From here
    // onward the driver may re-read/re-resolve state, but never clicks the
    // trigger again between range endpoints to "ensure" openness.
    const opened = await openIfClosed(port, target);
    if (!opened.ok) {
      return calendarFailure(
        opened.errorCode,
        opened.cause,
        opened.message,
        emptyRead(),
        opened.details,
      );
    }
    let actions = opened.wasOpen ? 0 : 1;
    let container = opened.container;
    let lastRead = emptyRead();
    const displayed = new Set<string>();
    const dates = intent.kind === 'date' ? [intent.date] : [intent.from, intent.to];

    let resetTried = false;
    for (const [index, date] of dates.entries()) {
      const current = await resolveContainer(port, target, { allowUnlinked: true });
      if (current) container = current;
      let clicked = await findAndClickDate(
        port,
        target,
        container,
        date,
        budget,
        displayed,
        actions,
      );
      // A range picker that is mid-selection greys out everything before the
      // start it is waiting to pair — so "disabled" can describe the widget's
      // transient state rather than the date's availability. A previous
      // interaction (this run's own earlier attempt, or the model's) is enough
      // to leave it there. Reopening reverts a picker to its last committed
      // pair, so the claim is re-tested against a clean widget once before it
      // is believed. Only the opening endpoint qualifies: once this drive has
      // clicked a start, a disabled end really is out of range.
      if (!clicked.ok && index === 0 && !resetTried && isDisabledDate(clicked)) {
        resetTried = true;
        const reopened = await reopenWidget(port, target);
        if (reopened) {
          container = reopened;
          actions += 1;
          clicked = await findAndClickDate(
            port,
            target,
            container,
            date,
            budget,
            displayed,
            actions,
          );
        }
      }
      lastRead = clicked.read;
      if (!clicked.ok) return clicked;
      actions = clicked.actions;
    }

    const committed = await readCommitted(port, target);
    if (matchesIntent(committed, intent)) {
      return { ok: true, driver: 'calendar-grid', committed, actions, container };
    }
    // An open picker has not finished reporting. Some commit only when released,
    // and some spread a range over a check-in/check-out pair whose second copy
    // exists only while the popup is up. Either way the trigger legitimately
    // still reads its old value here, so the authoritative check belongs to the
    // engine, which releases the widget first and fails there if it never lands.
    const open = await resolveContainer(port, target, { allowUnlinked: true });
    if (open && (await isOpen(port, target, open))) {
      return { ok: true, driver: 'calendar-grid', committed, actions, container: open };
    }
    // A picker that spreads the range over two controls holds half of it in
    // each, so this control cannot show the range whatever it does — reading it
    // alone and calling the drive failed condemns a selection that landed. The
    // engine reads both ends after release and is the only place that can
    // decide; the driver's job here is to not decide it wrongly first.
    if (intent.kind === 'date_range' && (await resolveDatePair(port, target))) {
      return { ok: true, driver: 'calendar-grid', committed, actions, container };
    }
    return calendarFailure(
      'WIDGET_NOT_COMMITTED',
      'value-rejected-on-release',
      `The calendar clicks landed, but "${target.name}" does not reflect the requested date${intent.kind === 'date_range' ? ' range' : ''}.`,
      lastRead,
      { committed },
      displayed,
    );
  },
};

async function findAndClickDate(
  port: WidgetPort,
  target: WidgetTarget,
  initialContainer: WidgetContainer,
  date: string,
  budget: Parameters<WidgetDriver['drive']>[3],
  displayed: Set<string>,
  initialActions: number,
): Promise<ClickDateResult> {
  let container = initialContainer;
  let actions = initialActions;
  let pagingSteps = 0;
  let lastRead = emptyRead();
  const targetMonth = date.slice(0, 7);

  for (;;) {
    if (port.now() > budget.deadlineMs || actions >= budget.maxActions) {
      return withRead(
        calendarFailure(
          'WIDGET_TARGET_UNREACHABLE',
          'budget',
          'The calendar action budget was exhausted.',
          lastRead,
          { reason: 'budget' },
          displayed,
        ),
        lastRead,
      );
    }

    const grid = await readWithFallback(port, container);
    grid.displayedMonths.forEach((month) => displayed.add(month));
    if (grid.cells.length === 0) {
      return withRead(
        calendarFailure(
          'WIDGET_TARGET_UNREACHABLE',
          'driver-not-recognized',
          `The calendar container is open, ${grid.elementsScanned} elements were scanned, and 0 day cells were recognized.`,
          grid,
          { reason: 'empty_calendar' },
          displayed,
        ),
        grid,
      );
    }

    const panelCells = grid.cells.filter((cell) => cell.derivedDate.startsWith(`${targetMonth}-`));
    const unsafe = panelCells.find((cell) => cell.unsafe);
    if (unsafe) {
      return withRead(
        calendarFailure(
          'WIDGET_MAPPING_UNSAFE',
          'mapping-unsafe',
          `The ${unsafe.monthLabel} calendar disagrees with its weekday headers, so no date was clicked.`,
          grid,
          {
            derived: unsafe.weekdayFromDate,
            column: unsafe.weekdayFromColumn,
            date: unsafe.derivedDate,
          },
          displayed,
        ),
        grid,
      );
    }

    const matches = grid.cells.filter((cell) => cell.derivedDate === date);
    if (matches.length > 1) {
      return withRead(
        calendarFailure(
          'WIDGET_AMBIGUOUS_CHOICE',
          'several-matched-equally',
          `The calendar exposes ${matches.length} cells for ${date}.`,
          grid,
          { offered: matches.slice(0, 10).map((cell) => `${cell.monthLabel}: ${cell.name}`) },
          displayed,
        ),
        grid,
      );
    }
    if (matches.length === 1) {
      const match = matches[0]!;
      if (match.disabled) {
        return withRead(
          calendarFailure(
            'WIDGET_TARGET_UNREACHABLE',
            'date-not-reachable',
            `The requested date ${date} is disabled.`,
            grid,
            { reason: 'disabled', date },
            displayed,
          ),
          grid,
        );
      }
      await clickCandidate(port, {
        name: match.name,
        role: 'button',
        disabled: match.disabled,
        path: match.path,
        group: match.group,
      });
      return { ok: true, actions: actions + 1, read: grid };
    }

    if (pagingSteps >= budget.maxPagingSteps) {
      return withRead(unreachable(date, displayed, 'paging bound reached', grid), grid);
    }
    const direction = directionFor(targetMonth, grid);
    if (!direction) {
      return withRead(
        unreachable(date, displayed, 'target month is not represented safely', grid),
        grid,
      );
    }
    const control = await pagingControl(port, direction);
    if (!control || control.disabled) {
      return withRead(unreachable(date, displayed, `${direction} control unavailable`, grid), grid);
    }
    const before = grid.displayedMonths;
    await port.click(control.ref);
    actions += 1;
    pagingSteps += 1;
    const resolved = await resolveContainer(port, target, { allowUnlinked: true });
    if (resolved) container = resolved;
    const after = await readWithFallback(port, container);
    lastRead = after;
    after.displayedMonths.forEach((month) => displayed.add(month));
    if (!advancedToward(before, after.displayedMonths, direction)) {
      return withRead(
        unreachable(date, displayed, 'paging did not advance the displayed month', after),
        after,
      );
    }
  }
}

/** True for the "that day is greyed out" outcome specifically. */
function isDisabledDate(result: ClickDateResult): boolean {
  return (
    !result.ok &&
    result.errorCode === 'WIDGET_TARGET_UNREACHABLE' &&
    result.details.reason === 'disabled'
  );
}

/**
 * Close and reopen the picker to clear any half-finished selection, returning
 * the fresh container, or null when it could not be brought back.
 *
 * Escape is the close: it is the one gesture every popup honours, and unlike a
 * second trigger click it cannot toggle the widget back open.
 */
async function reopenWidget(
  port: WidgetPort,
  target: WidgetTarget,
): Promise<WidgetContainer | null> {
  await port.press('Escape');
  const reopened = await openIfClosed(port, target);
  return reopened.ok ? reopened.container : null;
}

function directionFor(targetMonth: string, grid: CalendarGridRead): 'next' | 'previous' | null {
  if (grid.displayedMonths.length === 0) return null;
  if (targetMonth < grid.displayedMonths[0]!) return 'previous';
  if (targetMonth > grid.displayedMonths[grid.displayedMonths.length - 1]!) return 'next';
  return null;
}

async function pagingControl(
  port: WidgetPort,
  direction: 'next' | 'previous',
): Promise<{ readonly ref: string; readonly disabled: boolean } | null> {
  const observation = await port.observe({ cap: 400, trackDigest: false });
  const pattern =
    direction === 'next' ? /^next(?:\s+(?:month|year))?$/i : /^previous(?:\s+(?:month|year))?$/i;
  const matches = observation.interactables.filter((entry) => pattern.test(entry.name.trim()));
  if (matches.length !== 1) return null;
  return { ref: matches[0]!.ref, disabled: matches[0]!.disabled === true };
}

function advancedToward(
  before: readonly string[],
  after: readonly string[],
  direction: 'next' | 'previous',
): boolean {
  if (before.length === 0 || after.length === 0) return false;
  return direction === 'next'
    ? after[after.length - 1]! > before[before.length - 1]!
    : after[0]! < before[0]!;
}

function unreachable(
  date: string,
  displayed: Set<string>,
  reason: string,
  read: CalendarGridRead,
): WidgetFailure {
  return calendarFailure(
    'WIDGET_TARGET_UNREACHABLE',
    'date-not-reachable',
    `The calendar could not reach ${date}: ${reason}.`,
    read,
    { reason },
    displayed,
  );
}

async function readWithFallback(
  port: WidgetPort,
  container: WidgetContainer,
): Promise<CalendarGridRead> {
  const scoped = await readCalendarGrid(port, container);
  if (scoped.cells.length > 0) return scoped;
  const wide = await readCalendarGrid(port);
  return {
    ...wide,
    containerResolved: scoped.containerResolved,
    elementsScanned: scoped.elementsScanned + wide.elementsScanned,
    monthsParsed: [...new Set([...scoped.monthsParsed, ...wide.monthsParsed])].sort(),
  };
}

function emptyRead(): CalendarGridRead {
  return {
    cells: [],
    displayedMonths: [],
    containerResolved: false,
    cellsSeen: 0,
    monthsParsed: [],
    elementsScanned: 0,
  };
}

function calendarFailure(
  errorCode: WidgetFailure['errorCode'],
  cause: InteractionFailureCause,
  message: string,
  read: CalendarGridRead,
  details: Readonly<Record<string, unknown>> = {},
  displayed?: ReadonlySet<string>,
): WidgetFailure {
  return widgetFailure(errorCode, cause, message, {
    ...details,
    containerResolved: read.containerResolved,
    cellsSeen: read.cellsSeen,
    monthsParsed: read.monthsParsed,
    displayedMonths: displayed ? [...displayed] : read.displayedMonths,
  });
}

function withRead(
  failure: WidgetFailure,
  read: CalendarGridRead,
): WidgetFailure & { readonly read: CalendarGridRead } {
  return { ...failure, read };
}
