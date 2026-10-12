import { describe, expect, it } from 'vitest';

import {
  CELL_CHARS,
  MAX_TABLES,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
} from '../../../src/extraction/page/tables.js';

import { analyzeWithoutArticle, documentWith, extractPage, pageFixture } from './helpers.js';

function rowsOf(count: number, columns = 2): string {
  return Array.from(
    { length: count },
    (_, r) =>
      `<tr>${Array.from({ length: columns }, (_, c) => `<td>r${r}c${c}</td>`).join('')}</tr>`,
  ).join('');
}

describe('@no-llm extraction/page/tables', () => {
  it('reaches the answer in the second table by its document-order index', async () => {
    const page = await extractPage(pageFixture('multi-table.html'), 'https://heat.test/specs');
    expect(page.shape).toBe('table');
    expect(page.tables.map((table) => table.index)).toEqual([0, 1]);
    expect(page.tables[0]).toEqual({
      index: 0,
      kind: 'data',
      caption: 'Showroom hours',
      headers: ['Day', 'Opens', 'Closes'],
      rows: [
        ['Weekdays', '8:00', '18:00'],
        ['Saturday', '9:00', '16:00'],
        ['Sunday', 'Closed', 'Closed'],
      ],
    });
    expect(page.tables[1]?.caption).toBe('First-hour rating by tank size');
    expect(page.tables[1]?.rows).toContainEqual(['80 gal', 'Heat pump', '87 gal']);
    expect(page.coverage.tables).toEqual({ found: 2, shown: 2 });
  });

  it('gives a nested layout table no rows and the inner table the next index', () => {
    const html = documentWith(
      `<table><tr><td><table><thead><tr><th>A</th><th>B</th></tr></thead>${rowsOf(3)}</table></td><td>side</td></tr></table>`,
    );
    const { tables } = analyzeWithoutArticle(html);
    expect(tables.map((table) => [table.index, table.kind, table.rows.length])).toEqual([
      [0, 'layout', 0],
      [1, 'data', 3],
    ]);
  });

  it('treats a single-cell table as layout', () => {
    const { tables } = analyzeWithoutArticle(documentWith('<table><tr><td>Only</td></tr></table>'));
    expect(tables).toEqual([{ index: 0, kind: 'layout', caption: null, headers: [], rows: [] }]);
  });

  it('classifies a two-column label table as key-value, and a headed two-column table as data', () => {
    const page = analyzeWithoutArticle(pageFixture('detail-attributes.html'));
    expect(page.tables[0]?.kind).toBe('key-value');
    expect(page.tables[0]?.rows[0]).toEqual(['Exterior color', 'Desert Tan']);
    const headed = analyzeWithoutArticle(
      documentWith(`<table><tr><th>Year</th><th>Sales</th></tr>${rowsOf(4)}</table>`),
    );
    expect(headed.tables[0]?.kind).toBe('data');
    expect(headed.tables[0]?.headers).toEqual(['Year', 'Sales']);
  });

  it('shows 50 of 60 rows and names the table in the omission', () => {
    const page = analyzeWithoutArticle(
      documentWith(
        `<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>${rowsOf(60, 3)}</table>`,
      ),
    );
    expect(page.tables[0]?.rows).toHaveLength(MAX_TABLE_ROWS);
    expect(page.coverage.omitted).toContainEqual({
      id: 'table-rows-beyond-limit',
      count: 10,
      table: 0,
    });
  });

  it('bounds columns and cell text', () => {
    const wide = `<table>${rowsOf(3, 25)}</table>`;
    const long = `<table><tr><td>${'k'.repeat(10)} ${'v '.repeat(200)}</td><td>x</td><td>y</td></tr>${rowsOf(3, 3)}</table>`;
    const page = analyzeWithoutArticle(documentWith(wide + long));
    expect(page.tables[0]?.rows[0]).toHaveLength(MAX_TABLE_COLS);
    expect(page.coverage.omitted).toContainEqual({
      id: 'table-columns-beyond-limit',
      count: 1,
      table: 0,
    });
    expect(page.tables[1]?.rows[0]?.[0]?.length).toBeLessThanOrEqual(CELL_CHARS);
  });

  it('shows MAX_TABLES tables and counts every table found', () => {
    const tables = Array.from({ length: 12 }, () => `<table>${rowsOf(3, 3)}</table>`).join('');
    const page = analyzeWithoutArticle(documentWith(tables));
    expect(page.tables).toHaveLength(MAX_TABLES);
    expect(page.tables.every((table, index) => table.index === index)).toBe(true);
    expect(page.coverage.tables).toEqual({ found: 12, shown: MAX_TABLES });
    expect(page.coverage.omitted).toContainEqual({ id: 'tables-beyond-limit', count: 2 });
  });

  it('takes headers from a first row made only of th', () => {
    const page = analyzeWithoutArticle(
      documentWith(`<table><tr><th>Item</th><th>Qty</th><th>Cost</th></tr>${rowsOf(3, 3)}</table>`),
    );
    expect(page.tables[0]?.headers).toEqual(['Item', 'Qty', 'Cost']);
    expect(page.tables[0]?.rows).toHaveLength(3);
  });

  it('reports no tables as a not_found fact', () => {
    expect(analyzeWithoutArticle(documentWith('<p>none</p>')).coverage.not_found).toContain(
      'no tables',
    );
  });
});
