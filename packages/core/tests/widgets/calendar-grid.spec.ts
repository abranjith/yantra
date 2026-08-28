import { describe, expect, it } from 'vitest';

import { readCalendarGrid } from '../../src/index.js';
import { WidgetTestPort, monthTable } from '../support/widget-test-port.js';

describe('@no-llm calendar grid structural reader', () => {
  it('de-interleaves identical bare day numbers by their owning month', async () => {
    const port = new WidgetTestPort(
      `<div role="dialog">${monthTable(2026, 8)}${monthTable(2026, 9)}</div>`,
    );

    const grid = await readCalendarGrid(port);
    const sixes = grid.cells.filter((cell) => cell.day === 6);

    expect(sixes.map((cell) => cell.derivedDate)).toEqual(['2026-08-06', '2026-09-06']);
    expect(sixes.map((cell) => cell.group)).toEqual(['August 2026', 'September 2026']);
    expect(sixes.every((cell) => !cell.unsafe)).toBe(true);
  });

  it('marks a structurally shifted panel unsafe', async () => {
    const port = new WidgetTestPort(
      `<div role="dialog">${monthTable(2026, 8, { shift: -1 })}</div>`,
    );

    const grid = await readCalendarGrid(port);

    expect(grid.cells.some((cell) => cell.unsafe)).toBe(true);
    expect(grid.cells.find((cell) => cell.day === 1)).toMatchObject({
      derivedDate: '2026-08-01',
      weekdayFromColumn: 5,
      weekdayFromDate: 6,
    });
  });

  it('lets machine-readable dates bypass structural weekday derivation', async () => {
    const port = new WidgetTestPort(
      '<div role="dialog"><table><caption>August 2026</caption>' +
        '<thead><tr><th>Sun</th><th>Mon</th></tr></thead>' +
        '<tbody><tr><td><button data-date="2026-09-06">6</button></td></tr></tbody></table></div>',
    );

    const grid = await readCalendarGrid(port);

    expect(grid.cells[0]).toMatchObject({
      derivedDate: '2026-09-06',
      derivation: 'machine',
      unsafe: false,
    });
  });

  it('derives safe dates for Sunday-first and Monday-first grids', async () => {
    const sunday = await readCalendarGrid(new WidgetTestPort(monthTable(2026, 9)));
    const monday = await readCalendarGrid(
      new WidgetTestPort(monthTable(2026, 9, { mondayFirst: true })),
    );

    expect(sunday.cells.every((cell) => !cell.unsafe)).toBe(true);
    expect(monday.cells.every((cell) => !cell.unsafe)).toBe(true);
    expect(sunday.cells.find((cell) => cell.day === 6)?.weekdayFromColumn).toBe(0);
    expect(monday.cells.find((cell) => cell.day === 6)?.weekdayFromColumn).toBe(0);
  });

  it('derives a complete localized aria-label through Intl month names', async () => {
    const port = new WidgetTestPort(
      '<div role="grid"><div role="row"><button aria-label="dimanche 6 septembre 2026">6</button></div></div>',
    );
    port.document.documentElement.lang = 'fr-FR';

    const grid = await readCalendarGrid(port);

    expect(grid.cells[0]).toMatchObject({
      derivedDate: '2026-09-06',
      derivation: 'aria-label',
      unsafe: false,
    });
  });
});
