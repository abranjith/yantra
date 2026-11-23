import { EventInspector } from '@yantra/ui';
import { Fragment, type ReactNode } from 'react';

import type { SurfaceRead } from '../surfaces/definitions.js';

import { humanize, recordBody, type SchemaLike } from './table-model.js';
import { useDocument } from './use-document.js';

export interface GeneratedRecordProps {
  readonly read: SurfaceRead;
  readonly schema: SchemaLike;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The label/value pairs of a record. A record whose only field is an object
 * (`config list` prints `{config: {…}}`) shows that object's fields, since the
 * section title already names it.
 */
export function recordEntries(body: unknown): [string, unknown][] {
  if (!isPlainObject(body)) return [['value', body]];
  const entries = Object.entries(body);
  const [only] = entries;
  return entries.length === 1 && only !== undefined && isPlainObject(only[1])
    ? Object.entries(only[1])
    : entries;
}

/** Nested objects show as label/value lists this many levels down; deeper ones as a tree. */
const LIST_DEPTH = 2;

/** Label/value pairs; `depth` 0 is the record itself. */
function RecordList({
  entries,
  depth,
}: {
  readonly entries: readonly [string, unknown][];
  readonly depth: number;
}): ReactNode {
  return (
    <dl
      className={
        depth === 0
          ? 'grid grid-cols-[minmax(8rem,max-content)_minmax(0,1fr)] gap-x-6 gap-y-2'
          : 'grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1'
      }
    >
      {entries.map(([key, value]) => (
        <Fragment key={key}>
          <dt className={depth === 0 ? 'text-ink-2' : 'text-ink-3'}>{humanize(key)}</dt>
          <dd className="min-w-0 text-ink">
            <RecordValue value={value} label={humanize(key)} depth={depth} />
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A value as text when it is one, a nested list for a shallow object, otherwise a tree. */
function RecordValue({
  value,
  label,
  depth,
}: {
  readonly value: unknown;
  readonly label: string;
  readonly depth: number;
}): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span className="text-ink-3">—</span>;
  }
  if (isScalar(value)) return <span className="break-all">{String(value)}</span>;
  if (Array.isArray(value) && value.length === 0) return <span className="text-ink-3">None</span>;
  if (Array.isArray(value) && value.every(isScalar)) return value.join(', ');
  if (isPlainObject(value) && depth < LIST_DEPTH) {
    return <RecordList entries={Object.entries(value)} depth={depth + 1} />;
  }
  return <EventInspector value={value} label={label} expandedDepth={1} />;
}

/**
 * A command's `--json` document that is one record, not rows (`config list`,
 * `daemon status`): its fields as a label/value list, without the envelope.
 */
export function GeneratedRecord({ read, schema }: GeneratedRecordProps): ReactNode {
  const state = useDocument(read, schema);
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
        Couldn’t load {read.title}. {state.message}
      </p>
    );
  }
  return (
    <div
      role="group"
      aria-label={read.title}
      className="rounded-control border border-rule bg-surface px-4 py-3"
    >
      <RecordList entries={recordEntries(recordBody(state.document))} depth={0} />
    </div>
  );
}
