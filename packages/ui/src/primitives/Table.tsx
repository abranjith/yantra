/**
 * Table: virtualized, cursor-paged and accessible (TASK-011).
 *
 * Built on React Aria's `Table` inside `Virtualizer` with `TableLayout`, so
 * 10,000 rows render with a bounded DOM. Paging is the caller's business:
 * the table renders React Aria's load-more sentinel row and calls
 * `onLoadMore` when it scrolls into view, only while `loadState` is `idle`.
 */

import type { CSSProperties, Key, ReactNode } from 'react';
import {
  Cell,
  Collection,
  Column,
  Row,
  Table as AriaTable,
  TableBody,
  TableHeader,
  TableLayout,
  TableLoadMoreItem,
  Virtualizer,
} from 'react-aria-components';

import { cn, focusRing } from '../lib/cn.js';

import { Button } from './Button.js';

export interface TableColumn<T> {
  readonly id: string;
  readonly header: string;
  readonly cell: (row: T) => ReactNode;
  /** Exactly one column names each row for assistive technology. */
  readonly isRowHeader?: boolean;
  readonly width?: number | `${number}fr` | `${number}%`;
  readonly align?: 'start' | 'end';
  /** `engine` sets the cell in the mono voice (IDs, URLs, refs). */
  readonly voice?: 'body' | 'engine';
}

/**
 * `idle`: more may load; `loading`: a page is in flight; `error`: the last
 * page failed (a Retry row shows); `exhausted`: there is nothing more.
 */
export type TableLoadState = 'idle' | 'loading' | 'error' | 'exhausted';

interface TableBaseProps<T extends object> {
  readonly columns: readonly TableColumn<T>[];
  readonly rows: readonly T[];
  readonly getRowKey: (row: T) => string;
  readonly onRowAction?: (key: string) => void;
  readonly loadState?: TableLoadState;
  readonly onLoadMore?: () => void;
  readonly emptyState: ReactNode;
  /** Fixed row height in px, so the virtualizer never measures. Default 40. */
  readonly rowHeight?: number;
  /** The scroll viewport's height (any CSS length). Default 24rem. */
  readonly height?: string;
  readonly className?: string;
}

/** An accessible name is required, by `aria-label` or `aria-labelledby`. */
export type TableProps<T extends object> = TableBaseProps<T> &
  (
    | { readonly 'aria-label': string; readonly 'aria-labelledby'?: never }
    | { readonly 'aria-labelledby': string; readonly 'aria-label'?: never }
  );

/** A developer contract broken at render time (not a runtime data error). */
export class TableContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableContractError';
  }
}

/**
 * @throws {TableContractError} unless exactly one column is the row header;
 *   without one, screen readers cannot name rows.
 */
export function assertOneRowHeader(columns: readonly TableColumn<never>[]): void {
  const headers = columns.filter((column) => column.isRowHeader === true).length;
  if (headers !== 1) {
    throw new TableContractError(
      `Drshya Table needs exactly one column with isRowHeader; found ${String(headers)}.`,
    );
  }
}

const CELL = 'flex h-full items-center truncate px-3 text-ink';

function LoadMoreRow({
  loadState,
  onLoadMore,
}: {
  readonly loadState: TableLoadState;
  readonly onLoadMore: (() => void) | undefined;
}): ReactNode {
  if (loadState === 'exhausted' || onLoadMore === undefined) {
    return null;
  }
  // React Aria shows the sentinel's children only while `isLoading`; the
  // error row reuses that slot, without onLoadMore, so it never auto-retries.
  return (
    <TableLoadMoreItem
      isLoading={loadState !== 'idle'}
      {...(loadState === 'idle' ? { onLoadMore } : {})}
      className="text-ink-2"
    >
      {loadState === 'error' ? (
        <span className="flex h-full items-center gap-3 px-3">
          <span className="text-signal-failed-ink">Couldn’t load more</span>
          <Button size="sm" variant="secondary" icon="action.retry" onPress={onLoadMore}>
            Retry
          </Button>
        </span>
      ) : (
        <span className="flex h-full items-center px-3" role="status">
          Loading more…
        </span>
      )}
    </TableLoadMoreItem>
  );
}

/** The Drshya data table. */
export function Table<T extends object>(props: TableProps<T>): ReactNode {
  const {
    columns,
    rows,
    getRowKey,
    onRowAction,
    loadState = 'exhausted',
    onLoadMore,
    emptyState,
    rowHeight = 40,
    height = '24rem',
    className,
  } = props;
  assertOneRowHeader(columns);

  const label =
    props['aria-label'] === undefined
      ? { 'aria-labelledby': props['aria-labelledby'] }
      : { 'aria-label': props['aria-label'] };
  return (
    <div
      style={{ '--table-height': height } as CSSProperties}
      className={cn(
        'h-(--table-height) overflow-hidden rounded-control border border-rule',
        className,
      )}
    >
      <Virtualizer layout={TableLayout} layoutOptions={{ rowHeight, headingHeight: rowHeight }}>
        <AriaTable
          {...label}
          {...(onRowAction === undefined
            ? {}
            : { onRowAction: (key: Key) => onRowAction(String(key)) })}
          className="h-full w-full overflow-auto bg-surface text-body"
        >
          <TableHeader columns={columns} className="sticky top-0 z-10 bg-sunken">
            {(column) => (
              <Column
                id={column.id}
                {...(column.isRowHeader === true ? { isRowHeader: true } : {})}
                {...(column.width === undefined ? {} : { width: column.width })}
                className={focusRing({
                  className: cn(
                    'type-label flex h-full items-center border-b border-rule px-3 text-ink-2',
                    column.align === 'end' && 'justify-end',
                  ),
                })}
              >
                {column.header}
              </Column>
            )}
          </TableHeader>
          <TableBody
            renderEmptyState={() => (
              <div className="flex h-full items-center justify-center p-6 text-ink-2">
                {emptyState}
              </div>
            )}
          >
            <Collection items={rows} dependencies={[columns]}>
              {(row) => (
                <Row
                  id={getRowKey(row)}
                  columns={columns}
                  className={focusRing({
                    className:
                      'border-b border-rule hover:bg-sunken selected:bg-sunken -outline-offset-2',
                  })}
                >
                  {(column) => (
                    <Cell
                      className={focusRing({
                        className: cn(
                          CELL,
                          column.voice === 'engine' && 'type-engine',
                          column.align === 'end' && 'justify-end',
                          '-outline-offset-2',
                        ),
                      })}
                    >
                      {column.cell(row)}
                    </Cell>
                  )}
                </Row>
              )}
            </Collection>
            <LoadMoreRow loadState={loadState} onLoadMore={onLoadMore} />
          </TableBody>
        </AriaTable>
      </Virtualizer>
    </div>
  );
}
