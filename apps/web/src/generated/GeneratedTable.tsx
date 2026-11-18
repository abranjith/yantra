import { findLeaf } from '@yantra/protocol/commands';
import {
  Button,
  Dialog,
  Disclosure,
  DisclosurePanel,
  DisclosureTrigger,
  Table,
  type TableColumn,
} from '@yantra/ui';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { useRpc } from '../host/app-rpc.js';

import { GeneratedForm } from './GeneratedForm.js';
import { deriveColumns, resolvePointer, rowsFromEnvelope, type SchemaLike } from './table-model.js';

export interface GeneratedTableRowAction {
  readonly command: string;
  readonly label: string;
  readonly bind: Readonly<Record<string, string>>;
}

export interface GeneratedTableProps {
  readonly method: string;
  readonly schema: SchemaLike;
  readonly args?: readonly string[];
  readonly options?: Readonly<Record<string, string | boolean>>;
  readonly title: string;
  readonly rowActions?: readonly GeneratedTableRowAction[];
  readonly cwd?: string;
}

function cell(value: unknown, nested: boolean): ReactNode {
  if (nested)
    return (
      <Disclosure>
        <DisclosureTrigger>Show</DisclosureTrigger>
        <DisclosurePanel>
          <pre className="type-engine whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>
        </DisclosurePanel>
      </Disclosure>
    );
  return value === null || value === undefined
    ? '—'
    : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : JSON.stringify(value);
}

export function GeneratedTable({
  method,
  schema,
  args = [],
  options = {},
  title,
  rowActions = [],
  cwd = '/',
}: GeneratedTableProps): ReactNode {
  const rpc = useRpc();
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'idle' | 'error' | 'exhausted'>('loading');
  const [action, setAction] = useState<{
    readonly definition: GeneratedTableRowAction;
    readonly row: Record<string, unknown>;
  } | null>(null);
  const columns = useMemo<TableColumn<Record<string, unknown>>[]>(
    () => [
      ...deriveColumns(schema).map((column, index) => ({
        id: column.id,
        header: column.label,
        isRowHeader: index === 0,
        cell: (row: Record<string, unknown>) => cell(row[column.id], column.nested),
      })),
      ...(rowActions.length === 0
        ? []
        : [
            {
              id: 'actions',
              header: 'Actions',
              cell: (row: Record<string, unknown>) => (
                <span className="flex gap-2">
                  {rowActions.map((definition) => (
                    <Button
                      key={definition.command}
                      size="sm"
                      variant="secondary"
                      onPress={() => setAction({ definition, row })}
                    >
                      {definition.label}
                    </Button>
                  ))}
                </span>
              ),
            },
          ]),
    ],
    [schema, rowActions],
  );
  const load = async (next?: string): Promise<void> => {
    setState('loading');
    try {
      const result = await rpc.request<{ value: unknown; next_cursor: string | null }>(method, {
        args,
        options,
        ...(next === undefined ? {} : { cursor: next }),
      });
      const parsed = rowsFromEnvelope(result.value).map((row) =>
        row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : { value: row },
      );
      setRows((current) => (next === undefined ? parsed : [...current, ...parsed]));
      setCursor(result.next_cursor);
      setState(result.next_cursor === null ? 'exhausted' : 'idle');
    } catch {
      setState('error');
    }
  };
  useEffect(() => {
    void load();
  }, [method, JSON.stringify(args), JSON.stringify(options)]);
  if (state === 'loading' && rows.length === 0) return <p role="status">Loading {title}…</p>;
  if (state === 'error' && rows.length === 0) return <p role="alert">Couldn’t load {title}.</p>;
  return (
    <>
      <Table
        aria-label={title}
        columns={
          columns.length === 0
            ? [
                {
                  id: 'value',
                  header: 'Value',
                  isRowHeader: true,
                  cell: (row) => cell(row.value, false),
                },
              ]
            : columns
        }
        rows={rows}
        getRowKey={(row) => {
          const key = row.id ?? row.name ?? row.key;
          return typeof key === 'string' || typeof key === 'number'
            ? String(key)
            : String(rows.indexOf(row));
        }}
        emptyState={`No ${title.toLowerCase()}.`}
        loadState={state}
        {...(cursor === null ? {} : { onLoadMore: () => void load(cursor) })}
      />
      {action === null ? null : (
        <Dialog
          title={action.definition.label}
          isOpen
          onOpenChange={(open) => {
            if (!open) setAction(null);
          }}
        >
          {(() => {
            const command = findLeaf(action.definition.command.split(' '));
            if (command === undefined) return <p>Command unavailable.</p>;
            const initial = Object.fromEntries(
              Object.entries(action.definition.bind).map(([field, pointer]) => [
                field,
                String(resolvePointer(action.row, pointer)),
              ]),
            );
            return <GeneratedForm command={command} cwd={cwd} initialValues={initial} />;
          })()}
        </Dialog>
      )}
    </>
  );
}
