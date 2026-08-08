import {
  isOpen,
  openIfClosed,
  resolveContainer,
  restore,
  type WidgetContainer,
} from '../open-state.js';
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

interface ClickDateResult {
  readonly ok: true;
  readonly actions: number;
}

/** Driver for popup calendars rendered as table/grid day cells. */
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
      return current?.querySelector('table,[role="grid"]') ? 0.75 : 0;
    }, container.path);
  },
  drive: async (port, target, intent, budget) => {
    if (intent.kind !== 'date' && intent.kind !== 'date_range') {
      return widgetFailure('WIDGET_TARGET_UNREACHABLE', 'A calendar accepts only date intents.');
    }
    const opened = await openIfClosed(port, target);
    if (!opened.ok) return opened;
    let actions = opened.wasOpen ? 0 : 1;
    let container: WidgetContainer;
    const displayed = new Set<string>();
    try {
      const dates = intent.kind === 'date' ? [intent.date] : [intent.from, intent.to];
      for (const date of dates) {
        const current = await resolveContainer(port, target, { allowUnlinked: true });
        if (!current || !(await isOpen(port, target, current))) {
          const reopened = await openIfClosed(port, target);
          if (!reopened.ok) return reopened;
          container = reopened.container;
          if (!reopened.wasOpen) actions += 1;
        } else {
          container = current;
        }
        const clicked = await findAndClickDate(
          port,
          target,
          container,
          date,
          budget,
          displayed,
          actions,
        );
        if (!clicked.ok) return clicked;
        actions = clicked.actions;
      }
      const committed = await readCommitted(port, target);
      if (!matchesIntent(committed, intent)) {
        return widgetFailure(
          'WIDGET_NOT_COMMITTED',
          `The calendar clicks landed, but "${target.name}" does not reflect the requested date${intent.kind === 'date_range' ? ' range' : ''}.`,
          { committed },
        );
      }
      return { ok: true, driver: 'calendar-grid', committed, actions };
    } finally {
      await restore(port, target, opened.wasOpen);
    }
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
): Promise<ClickDateResult | WidgetFailure> {
  let container = initialContainer;
  let actions = initialActions;
  let pagingSteps = 0;
  const targetMonth = date.slice(0, 7);
  for (;;) {
    if (port.now() > budget.deadlineMs || actions >= budget.maxActions) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'The calendar action budget was exhausted.',
        {
          reason: 'budget',
          displayedMonths: [...displayed],
        },
      );
    }
    // Container scope is an optimization, not a safety property: it narrows
    // where we look, and nothing about correctness rests on it. A scoped read
    // that finds no day cells at all therefore means the container is wrong,
    // not that the page has no calendar — so widen to the document rather than
    // report a month unreachable that is sitting there on screen. Every real
    // guard still runs on the wider read: a date must match exactly one cell,
    // structural derivations are weekday-checked, and a disabled cell refuses.
    let grid = await readCalendarGrid(port, container);
    if (grid.cells.length === 0) grid = await readCalendarGrid(port);
    grid.displayedMonths.forEach((month) => displayed.add(month));
    const panelCells = grid.cells.filter((cell) => cell.derivedDate.startsWith(`${targetMonth}-`));
    const unsafe = panelCells.find((cell) => cell.unsafe);
    if (unsafe) {
      return widgetFailure(
        'WIDGET_MAPPING_UNSAFE',
        `The ${unsafe.monthLabel} calendar disagrees with its weekday headers, so no date was clicked.`,
        {
          derived: unsafe.weekdayFromDate,
          column: unsafe.weekdayFromColumn,
          date: unsafe.derivedDate,
        },
      );
    }
    const matches = grid.cells.filter((cell) => cell.derivedDate === date);
    if (matches.length > 1) {
      return widgetFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        `The calendar exposes ${matches.length} cells for ${date}.`,
        { offered: matches.slice(0, 10).map((cell) => `${cell.monthLabel}: ${cell.name}`) },
      );
    }
    if (matches.length === 1) {
      const match = matches[0]!;
      if (match.disabled) {
        return widgetFailure(
          'WIDGET_TARGET_UNREACHABLE',
          `The requested date ${date} is disabled.`,
          { reason: 'disabled', date },
        );
      }
      await clickCandidate(port, {
        name: match.name,
        role: 'button',
        disabled: match.disabled,
        path: match.path,
        group: match.group,
      });
      return { ok: true, actions: actions + 1 };
    }
    if (pagingSteps >= budget.maxPagingSteps) {
      return unreachable(date, displayed, 'paging bound reached');
    }
    const direction = directionFor(targetMonth, grid);
    if (!direction) return unreachable(date, displayed, 'target month is not represented safely');
    const control = await pagingControl(port, direction);
    if (!control || control.disabled)
      return unreachable(date, displayed, `${direction} control unavailable`);
    const before = grid.displayedMonths;
    await port.click(control.ref);
    actions += 1;
    pagingSteps += 1;
    const resolved = await resolveContainer(port, target, { allowUnlinked: true });
    if (resolved) container = resolved;
    let after = await readCalendarGrid(port, container);
    if (after.cells.length === 0) after = await readCalendarGrid(port);
    after.displayedMonths.forEach((month) => displayed.add(month));
    if (!advancedToward(before, after.displayedMonths, direction)) {
      return unreachable(date, displayed, 'paging did not advance the displayed month');
    }
  }
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

function unreachable(date: string, displayed: Set<string>, reason: string): WidgetFailure {
  return widgetFailure(
    'WIDGET_TARGET_UNREACHABLE',
    `The calendar could not reach ${date}: ${reason}.`,
    { displayedMonths: [...displayed], reason },
  );
}
