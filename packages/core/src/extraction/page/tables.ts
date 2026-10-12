/**
 * Every table on a page, by document-order index (FEAT-051, closes TODO 214).
 *
 * The old browser path read only the first `<table>`, so a page whose answer
 * sat in its second table could not answer (FEAT-049's `multi-table`). Every
 * table now gets its 0-based pre-order ordinal among **all** tables, nested
 * ones included, which is the same number `browser_extract kind:"table",
 * index:n` takes.
 */

import { closest, elementChildren, tagOf, type PageIndex, type PageNode } from './dom.js';
import { LABEL_MAX, rowCells } from './fields.js';
import type { PageTable } from './types.js';

/** Tables shown per page. */
export const MAX_TABLES = 10;

/** Rows shown per table. */
export const MAX_TABLE_ROWS = 50;

/** Columns shown per table. */
export const MAX_TABLE_COLS = 20;

/** Characters per cell. */
export const CELL_CHARS = 200;

/** Share of two-cell label rows that makes a table a key-value table. */
const KEY_VALUE_SHARE = 0.8;

/** A table read, with what its bounds dropped. */
export interface TableRead {
  readonly table: PageTable;
  /** Body rows beyond {@link MAX_TABLE_ROWS}. */
  readonly rowsDropped: number;
  /** Whether any row had columns beyond {@link MAX_TABLE_COLS}. */
  readonly colsDropped: boolean;
}

/** Every table, the shown subset, and the count. */
export interface TableScan {
  /** The first {@link MAX_TABLES} tables. */
  readonly reads: readonly TableRead[];
  /** Every `<table>` element on the page. */
  readonly found: number;
}

/**
 * Reads every table in document pre-order and classifies it:
 *
 * - `layout`: one cell, or holding a nested table; no rows are returned.
 * - `key-value`: no column-header row, and at least 80% of rows have exactly
 *   two cells whose first is a `th` or a short label.
 * - `data`: everything else.
 *
 * Headers come from the `thead`'s first row of `th`, or a first row made only
 * of `th`. Spans are not expanded.
 *
 * @param index The page index.
 */
export function readTables(index: PageIndex): TableScan {
  const all = index.select((node) => tagOf(node) === 'table');
  return {
    reads: all.slice(0, MAX_TABLES).map((node, position) => readTable(index, node, position)),
    found: all.length,
  };
}

/** Characters of data-table text that count toward the `table` shape: tables with ≥ 3 rows and ≥ 2 columns. */
export function dataTableChars(tables: readonly PageTable[]): number {
  let total = 0;
  for (const table of tables) {
    const columns = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 0);
    if (table.kind !== 'data' || table.rows.length < 3 || columns < 2) continue;
    for (const cell of [...table.headers, ...table.rows.flat()]) total += cell.length;
  }
  return total;
}

function readTable(index: PageIndex, node: PageNode, position: number): TableRead {
  const caption = captionOf(index, node);
  const rows = ownRows(index, node);
  const cellCount = rows.reduce((total, row) => total + rowCells(row).length, 0);
  const nested = index.within(node, (child) => tagOf(child) === 'table').length > 0;
  if (nested || cellCount <= 1) {
    return {
      table: { index: position, kind: 'layout', caption, headers: [], rows: [] },
      rowsDropped: 0,
      colsDropped: false,
    };
  }

  const headRow = rows.find((row) => closest(row, (el) => tagOf(el) === 'thead') !== null);
  const firstRow = rows[0];
  const headerRow =
    headRow ??
    (firstRow !== undefined && rowCells(firstRow).every((cell) => tagOf(cell) === 'th')
      ? firstRow
      : undefined);
  const bodyRows = rows.filter(
    (row) => row !== headerRow && closest(row, (el) => tagOf(el) === 'thead') === null,
  );
  let colsDropped = false;
  const readRow = (row: PageNode): string[] => {
    const cells = rowCells(row);
    if (cells.length > MAX_TABLE_COLS) colsDropped = true;
    return cells.slice(0, MAX_TABLE_COLS).map((cell) => index.textOf(cell).slice(0, CELL_CHARS));
  };
  const headers = headerRow === undefined ? [] : readRow(headerRow);

  const labelRows = bodyRows.filter((row) => {
    const cells = rowCells(row);
    const first = cells[0];
    return (
      cells.length === 2 &&
      first !== undefined &&
      (tagOf(first) === 'th' || index.textOf(first).length <= LABEL_MAX)
    );
  }).length;
  const keyValue =
    headers.length < 2 && bodyRows.length > 0 && labelRows / bodyRows.length >= KEY_VALUE_SHARE;

  const shown = bodyRows.slice(0, MAX_TABLE_ROWS).map(readRow);
  return {
    table: {
      index: position,
      kind: keyValue ? 'key-value' : 'data',
      caption,
      headers,
      rows: shown.filter((row) => row.some((cell) => cell.length > 0)),
    },
    rowsDropped: Math.max(0, bodyRows.length - MAX_TABLE_ROWS),
    colsDropped,
  };
}

/** Rows belonging to this table itself (not to a table nested inside it). */
function ownRows(index: PageIndex, table: PageNode): PageNode[] {
  return index.within(
    table,
    (node) => tagOf(node) === 'tr' && closest(node, (el) => tagOf(el) === 'table') === table,
  );
}

function captionOf(index: PageIndex, table: PageNode): string | null {
  const caption = elementChildren(table).find((child) => tagOf(child) === 'caption');
  if (caption === undefined) return null;
  const text = index.textOf(caption);
  return text.length > 0 ? text.slice(0, CELL_CHARS) : null;
}
