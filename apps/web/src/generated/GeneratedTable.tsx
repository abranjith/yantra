import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger, EventInspector, Table, type TableColumn } from '@yantra/ui';
import { useMemo, useState, type ReactNode } from 'react';

import type { RowAction, SurfaceRead } from '../surfaces/definitions.js';

import { GeneratedForm } from './GeneratedForm.js';
import {
  deriveColumns,
  resolvePointer,
  rowsOf,
  tableShape,
  type SchemaLike,
} from './table-model.js';
import { useDocument } from './use-document.js';

export interface GeneratedTableProps {
  readonly read: SurfaceRead;
  readonly schema: SchemaLike;
  readonly cwd?: string;
}

type Row = Record<string, unknown>;

/** The Drshya table's fixed row height; the header uses it too. */
const ROW_HEIGHT = 40;
/** Rows shown before the table scrolls. */
const MAX_VISIBLE_ROWS = 12;

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function Empty(): ReactNode {
  return <span className="text-ink-3">—</span>;
}

/** One cell: text for scalars and lists of scalars, a "Show" dialog for anything nested. */
function CellValue({
  value,
  label,
}: {
  readonly value: unknown;
  readonly label: string;
}): ReactNode {
  if (value === null || value === undefined || value === '') return <Empty />;
  const text = isScalar(value)
    ? String(value)
    : Array.isArray(value) && value.every(isScalar)
      ? value.join(', ')
      : null;
  if (text !== null) {
    return text === '' ? (
      <Empty />
    ) : (
      <span className="min-w-0 truncate" title={text}>
        {text}
      </span>
    );
  }
  return (
    <DialogTrigger>
      <Button size="sm" variant="quiet">
        Show
      </Button>
      <Dialog title={label}>
        <EventInspector value={value} label={label} />
      </Dialog>
    </DialogTrigger>
  );
}

/** The prefilled form for a row action, or why it cannot open. */
function RowActionForm({
  definition,
  row,
  cwd,
}: {
  readonly definition: RowAction;
  readonly row: Row;
  readonly cwd: string;
}): ReactNode {
  const command = findLeaf(definition.command.split(' '));
  if (command === undefined) return <p role="alert">{definition.command} is not a command.</p>;
  try {
    const initial = Object.fromEntries(
      Object.entries(definition.bind).map(([field, pointer]) => [
        field,
        String(resolvePointer(row, pointer)),
      ]),
    );
    return <GeneratedForm command={command} cwd={cwd} initialValues={initial} />;
  } catch (error) {
    return (
      <p role="alert">
        This row has no value for {definition.label}:{' '}
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }
}

/**
 * A command's `--json` rows as a Drshya table (FEAT-070). Columns come from
 * the row schema; row actions open the command's form prefilled from the row.
 */
export function GeneratedTable({ read, schema, cwd = '/' }: GeneratedTableProps): ReactNode {
  const shape = useMemo(() => tableShape(schema), [schema]);
  const state = useDocument(read, schema);
  const [action, setAction] = useState<{
    readonly definition: RowAction;
    readonly row: Row;
  } | null>(null);
  const rowActions = read.rowActions ?? [];

  if (state.status === 'loading') {
    return (
      <p role="status" className="text-ink-2">
        Loading…
      </p>
    );
  }
  if (state.status === 'failed') {
    return (
      <p role="alert" className="text-signal-failed-ink">
        Couldn’t load {read.title.toLowerCase()}. {state.message}
      </p>
    );
  }
  const rows = rowsOf(state.document, shape);
  if (rows.length === 0) {
    return (
      <p className="rounded-control border border-rule bg-surface px-4 py-3 text-ink-2">
        None yet.
      </p>
    );
  }
  const keys = new Map(rows.map((row, index) => [row, String(index)]));
  const columns: TableColumn<Row>[] = [
    ...deriveColumns(shape, rows).map((column, index) => ({
      id: column.id,
      header: column.label,
      ...(column.description === undefined ? {} : { description: column.description }),
      isRowHeader: index === 0,
      cell: (row: Row) => <CellValue value={row[column.id]} label={column.label} />,
    })),
    ...(rowActions.length === 0
      ? []
      : [
          {
            id: '__row-actions',
            header: 'Actions',
            cell: (row: Row) => (
              <span className="flex gap-2">
                {rowActions.map((definition) => (
                  <Button
                    key={definition.command}
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      setAction({ definition, row });
                    }}
                  >
                    {definition.label}
                  </Button>
                ))}
              </span>
            ),
          },
        ]),
  ];
  const visible = Math.min(rows.length, MAX_VISIBLE_ROWS);
  return (
    <>
      <Table
        aria-label={read.title}
        columns={columns}
        rows={rows}
        getRowKey={(row) => keys.get(row) ?? ''}
        emptyState="None yet."
        rowHeight={ROW_HEIGHT}
        // The header row and the visible rows, plus the 1px border top and bottom.
        height={`${String((visible + 1) * ROW_HEIGHT + 2)}px`}
      />
      {action === null ? null : (
        <Dialog
          title={action.definition.label}
          isOpen
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
        >
          <RowActionForm definition={action.definition} row={action.row} cwd={cwd} />
        </Dialog>
      )}
    </>
  );
}
