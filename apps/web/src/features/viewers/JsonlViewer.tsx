/**
 * The JSONL viewer (FEAT-066 TASK-008): a JSONL file of any length, read in
 * windows of 200 lines through `read.artifact_window`.
 *
 * - A virtualized Drshya Table with fixed-height rows, so the DOM stays
 *   bounded however long the file is. Each visible row loads the window that
 *   holds it, once.
 * - The list grows as the index learns more lines; "Go to the end" counts
 *   the whole file first.
 * - Each line parses as JSON; a line that does not is shown raw with a "not
 *   valid JSON" chip, failing only itself. Lines of `events.jsonl` and
 *   `run-events.jsonl` with a known kind get a one-line summary; any other
 *   line opens in the EventInspector when activated.
 */

import type { JsonlWindow } from '@yantra/protocol';
import { Button, EventInspector, Table, type TableColumn } from '@yantra/ui';
import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { jsonlWindowStart, useJsonlWindow } from '../../data/runs.js';
import { useRpc } from '../../host/app-rpc.js';
import { formatBytes } from '../format.js';

import { EVENT_FILES, summarizeEvent } from './event-summary.js';

/** One line of a window, as the viewer shows it. */
export interface ViewedLine {
  readonly n: number;
  readonly text: string;
  readonly truncatedBytes: number;
  /** Parsed JSON, or undefined when the line is not valid JSON (or was cut). */
  readonly value: unknown;
  readonly valid: boolean;
  /** The one-line summary of a known event, or null. */
  readonly summary: string | null;
}

/** Parses and summarizes one window line. */
export function viewLine(line: JsonlWindow['lines'][number], path: string): ViewedLine {
  let value: unknown;
  let valid = false;
  if (line.truncated_bytes === 0) {
    try {
      value = JSON.parse(line.text) as unknown;
      valid = true;
    } catch {
      valid = false;
    }
  }
  const name = path.split('/').at(-1) ?? path;
  return {
    n: line.n,
    text: line.text,
    truncatedBytes: line.truncated_bytes,
    value,
    valid,
    summary: valid && EVENT_FILES.has(name) ? summarizeEvent(value) : null,
  };
}

interface Row {
  readonly n: number;
}

function Chip({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <span className="type-label shrink-0 rounded-chip border border-signal-partial px-1.5 text-signal-partial-ink">
      {children}
    </span>
  );
}

/** One row's content: it loads the window that holds it. */
function LineCell({
  runId,
  path,
  n,
  onKnown,
}: {
  readonly runId: string;
  readonly path: string;
  readonly n: number;
  readonly onKnown: (window: JsonlWindow) => void;
}): ReactNode {
  const window = useJsonlWindow(runId, path, jsonlWindowStart(n));
  useEffect(() => {
    if (window.data !== undefined) onKnown(window.data);
  }, [window.data, onKnown]);
  if (window.isError)
    return <span className="text-signal-failed-ink">Couldn’t read this line.</span>;
  const line = window.data?.lines.find((item) => item.n === n);
  if (line === undefined) return <span className="text-ink-2">Loading…</span>;
  const viewed = viewLine(line, path);
  return (
    <span data-line={n} className="flex min-w-0 items-center gap-2">
      {viewed.truncatedBytes > 0 ? <Chip>cut at 16 KiB</Chip> : null}
      {!viewed.valid && viewed.truncatedBytes === 0 ? <Chip>not valid JSON</Chip> : null}
      <span className={viewed.summary === null ? 'type-engine truncate' : 'truncate'}>
        {viewed.summary ?? viewed.text}
      </span>
    </span>
  );
}

/** The selected line, in full. */
function LineDetail({
  runId,
  path,
  n,
}: {
  readonly runId: string;
  readonly path: string;
  readonly n: number;
}): ReactNode {
  const window = useJsonlWindow(runId, path, jsonlWindowStart(n));
  const line = window.data?.lines.find((item) => item.n === n);
  if (line === undefined) return <p className="text-ink-2">Loading line {n + 1}…</p>;
  const viewed = viewLine(line, path);
  return (
    <section aria-label={`Line ${String(n + 1)}`} className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-ink">Line {n + 1}</h2>
      {viewed.truncatedBytes > 0 ? (
        <p className="text-ink-2">
          This line is cut at 16 KiB; {formatBytes(viewed.truncatedBytes)} more are in the file.
        </p>
      ) : null}
      {viewed.valid ? (
        <EventInspector value={viewed.value} label={`Line ${String(n + 1)} details`} />
      ) : (
        <pre className="type-engine whitespace-pre-wrap break-all text-ink">{viewed.text}</pre>
      )}
    </section>
  );
}

export interface JsonlViewerProps {
  readonly runId: string;
  readonly path: string;
}

/** See the module comment. */
export function JsonlViewer({ runId, path }: JsonlViewerProps): ReactNode {
  const rpc = useRpc();
  const first = useJsonlWindow(runId, path, 0);
  const [known, setKnown] = useState<{
    lines: number;
    complete: boolean;
    partialTail: boolean;
  } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [extending, setExtending] = useState(false);

  const onKnown = useCallback((window: JsonlWindow) => {
    setKnown((current) =>
      current !== null &&
      current.lines >= window.total_lines_known &&
      current.complete === window.total_complete
        ? current
        : {
            lines: Math.max(current?.lines ?? 0, window.total_lines_known),
            complete: window.total_complete || (current?.complete ?? false),
            partialTail: window.partial_tail,
          },
    );
  }, []);

  useEffect(() => {
    if (first.data !== undefined) onKnown(first.data);
  }, [first.data, onKnown]);

  if (first.isError) {
    return <p className="text-signal-failed-ink">{first.error.message}</p>;
  }
  if (first.data === undefined || known === null) {
    return (
      <p role="status" className="text-ink-2">
        Loading {path}…
      </p>
    );
  }

  const extend = async (fromLine: number): Promise<JsonlWindow | null> => {
    setExtending(true);
    try {
      const window = await rpc.request<JsonlWindow>('read.artifact_window', {
        run_id: runId,
        path,
        from_line: fromLine,
        limit: 1,
      });
      onKnown(window);
      return window;
    } catch {
      return null;
    } finally {
      setExtending(false);
    }
  };

  const rows: Row[] = Array.from({ length: known.lines }, (_, n) => ({ n }));
  const columns: readonly TableColumn<Row>[] = [
    {
      id: 'n',
      header: 'Line',
      width: 80,
      align: 'end',
      voice: 'engine',
      cell: (row) => String(row.n + 1),
    },
    {
      id: 'content',
      header: 'Content',
      isRowHeader: true,
      cell: (row) => <LineCell runId={runId} path={path} n={row.n} onKnown={onKnown} />,
    },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-ink-2" data-part="line-count">
            {known.complete
              ? `${String(known.lines)} lines`
              : `At least ${String(known.lines)} lines`}
          </span>
          {known.partialTail ? (
            <span className="text-ink-2">The last line is still being written.</span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            isPending={extending}
            onPress={() => {
              // Counting past the end makes the index reach the end of the file.
              void extend(2 ** 31).then((window) => {
                // Show the last line in full: it is what `tail -n 1` prints.
                if (window !== null && window.total_lines_known > 0) {
                  setSelected(window.total_lines_known - 1);
                }
              });
            }}
          >
            Go to the end
          </Button>
        </div>
        <Table
          aria-label={`${path} lines`}
          columns={columns}
          rows={rows}
          getRowKey={(row) => String(row.n)}
          rowHeight={32}
          height="32rem"
          loadState={known.complete ? 'exhausted' : extending ? 'loading' : 'idle'}
          onLoadMore={() => {
            if (!known.complete && !extending) void extend(known.lines);
          }}
          onRowAction={(key) => {
            setSelected(Number(key));
          }}
          emptyState="This file has no complete lines yet."
        />
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        {selected === null ? (
          <p className="text-ink-2">Choose a line to see it in full.</p>
        ) : (
          <LineDetail runId={runId} path={path} n={selected} />
        )}
      </div>
    </div>
  );
}
