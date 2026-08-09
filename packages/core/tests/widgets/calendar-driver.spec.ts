import { describe, expect, it } from 'vitest';

import {
  calendarDriver,
  dateInputDriver,
  type WidgetBudget,
  type WidgetTarget,
} from '../../src/index.js';

import { CalendarTestPort, installDateCommit, monthTable } from './calendar-test-port.js';

const BUDGET: WidgetBudget = {
  deadlineMs: Number.MAX_SAFE_INTEGER,
  maxPagingSteps: 12,
  maxActions: 24,
};

describe('@no-llm calendar widget driver', () => {
  it('clicks the September cell named 6 rather than the August cell', async () => {
    const port = twoPanelPort();

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    expect(port.clickLog).toEqual([{ name: '6', group: 'September 2026' }]);
  });

  it('clicks a September date range in order', async () => {
    const port = twoPanelPort();

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date_range', from: '2026-09-06', to: '2026-09-08' },
      BUDGET,
    );

    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
    expect(port.clickLog).toEqual([
      { name: '6', group: 'September 2026' },
      { name: '8', group: 'September 2026' },
    ]);
  });

  it('refuses an unsafe weekday mapping without clicking', async () => {
    const port = new CalendarTestPort(
      '<button id="trigger" aria-controls="calendar" aria-expanded="true">Dates</button>' +
        `<div id="calendar" role="dialog">${monthTable(2026, 8, { shift: -1 })}</div>`,
    );

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-08-01' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_MAPPING_UNSAFE',
      details: { derived: 6, column: 5 },
    });
    expect(port.clickLog).toEqual([]);
  });

  it('pages exactly three months toward the target and succeeds', async () => {
    const port = pagingPort({ advancing: true });

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-11-15' },
      BUDGET,
    );

    expect(outcome.ok).toBe(true);
    expect(port.clickLog.filter((entry) => entry.name === 'Next month')).toHaveLength(3);
  });

  it('stops when paging is disabled before the target month', async () => {
    const port = pagingPort({ advancing: true, disabled: true });

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-11-15' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { displayedMonths: ['2026-08'] },
    });
    expect(port.clickLog).toEqual([]);
  });

  it('stops immediately when a paging control does not advance the month', async () => {
    const port = pagingPort({ advancing: false });

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-11-15' },
      BUDGET,
    );

    expect(outcome).toMatchObject({ ok: false, errorCode: 'WIDGET_TARGET_UNREACHABLE' });
    expect(port.clickLog.filter((entry) => entry.name === 'Next month')).toHaveLength(1);
  });

  it('does not click a disabled target date', async () => {
    const port = new CalendarTestPort(
      '<button id="trigger" aria-controls="calendar" aria-expanded="true">Dates</button>' +
        '<div id="calendar" role="dialog"><table><caption>September 2026</caption>' +
        '<tbody><tr><td><button data-date="2026-09-06" disabled>6</button></td></tr></tbody></table></div>',
    );

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      details: { reason: 'disabled' },
    });
    expect(port.clickLog).toEqual([]);
  });

  it('reports an unchanged trigger as not committed once the picker has closed', async () => {
    const port = new CalendarTestPort(
      '<button id="trigger" aria-controls="calendar" aria-expanded="false">Dates</button>' +
        '<div id="calendar" role="dialog" style="display:none">' +
        '<table><caption>September 2026</caption>' +
        '<tbody><tr><td><button data-date="2026-09-06">6</button></td></tr></tbody></table></div>',
    );
    // Opening reveals the picker; nothing closes it again, so the trigger is
    // read while the widget has already reported everything it is going to.
    const trigger = port.document.querySelector<HTMLElement>('#trigger')!;
    const popup = port.document.querySelector<HTMLElement>('#calendar')!;
    trigger.addEventListener('click', () => {
      popup.style.display = 'block';
      trigger.setAttribute('aria-expanded', 'true');
    });
    port.document.querySelector<HTMLElement>('#calendar button')!.addEventListener('click', () => {
      popup.style.display = 'none';
      trigger.setAttribute('aria-expanded', 'false');
    });

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'WIDGET_NOT_COMMITTED',
      details: { committed: 'Dates' },
    });
  });

  it('defers the verdict while the picker is still open, since it may commit on release', async () => {
    const port = new CalendarTestPort(
      '<button id="trigger" aria-controls="calendar" aria-expanded="true">Dates</button>' +
        '<div id="calendar" role="dialog"><table><caption>September 2026</caption>' +
        '<tbody><tr><td><button data-date="2026-09-06">6</button></td></tr></tbody></table></div>',
    );

    const outcome = await calendarDriver.drive(
      port,
      calendarTarget(),
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    // The engine releases the widget and performs the authoritative check;
    // failing here would reject a selection that is about to land.
    expect(outcome).toMatchObject({ ok: true, driver: 'calendar-grid' });
  });

  it('sets and verifies a native date input without opening anything', async () => {
    const port = new CalendarTestPort('<input id="trigger" type="date" aria-label="Check-in">');

    const outcome = await dateInputDriver.drive(
      port,
      { ...calendarTarget(), role: 'textbox', name: 'Check-in' },
      { kind: 'date', date: '2026-09-06' },
      BUDGET,
    );

    expect(outcome).toMatchObject({
      ok: true,
      driver: 'date-input',
      committed: '2026-09-06',
      actions: 1,
    });
    expect(port.clickLog).toEqual([]);
  });
});

function calendarTarget(): WidgetTarget {
  return { ref: 'e1', role: 'button', name: 'Dates', group: null, value: null };
}

function twoPanelPort(): CalendarTestPort {
  const port = new CalendarTestPort(
    '<button id="trigger" aria-controls="calendar" aria-expanded="true">Dates</button>' +
      `<div id="calendar" role="dialog">${monthTable(2026, 8)}${monthTable(2026, 9)}</div>`,
  );
  installDateCommit(port);
  return port;
}

function pagingPort(options: {
  readonly advancing: boolean;
  readonly disabled?: boolean;
}): CalendarTestPort {
  const port = new CalendarTestPort(
    '<button id="trigger" aria-controls="calendar" aria-expanded="true">Dates</button>' +
      `<div id="calendar" role="dialog"><button id="next"${options.disabled ? ' disabled' : ''}>Next month</button>` +
      '<div id="month"></div></div>',
  );
  let month = 8;
  const render = (): void => {
    const year = 2026 + Math.floor((month - 1) / 12);
    const normalizedMonth = ((month - 1) % 12) + 1;
    const label = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(year, normalizedMonth - 1, 1)));
    const iso = `${year}-${String(normalizedMonth).padStart(2, '0')}-15`;
    port.document.querySelector('#month')!.innerHTML =
      `<table><caption>${label}</caption><tbody><tr><td><button data-date="${iso}">15</button></td></tr></tbody></table>`;
    const dateButton = port.document.querySelector<HTMLButtonElement>('#month button')!;
    dateButton.addEventListener('click', () => {
      port.document
        .querySelector('#trigger')!
        .setAttribute('aria-label', `${label.split(' ')[0]} 15, ${year}`);
    });
  };
  render();
  port.document.querySelector('#next')!.addEventListener('click', () => {
    if (options.advancing) {
      month += 1;
      render();
    }
  });
  return port;
}
