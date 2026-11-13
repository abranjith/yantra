import { useState, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Disclosure, DisclosurePanel, DisclosureTrigger } from '../primitives/Disclosure.js';

/**
 * EventInspector (FEAT-066): a generic, bounded tree for any JSON value — an
 * event kind this app does not know, or one that fails validation.
 *
 * - `kind`, `seq` and `ts` come first; other keys keep their order.
 * - Depth is limited (default 6) and each level shows at most 200 entries,
 *   then "+N more".
 * - Strings over 2 KiB are collapsed behind "Show all".
 * - Keys and values are text: React escapes them, nothing is ever HTML.
 */

export interface JsonTreeOptions {
  /** Levels shown below the root; deeper values read "…". */
  readonly maxDepth?: number;
  /** Entries shown per object or array. */
  readonly maxEntries?: number;
  /** Keys listed first, in this order, when present. */
  readonly priorityKeys?: readonly string[];
  /** Strings longer than this (UTF-16 units) start collapsed. */
  readonly collapseStringsOver?: number;
  /** Containers shallower than this start expanded (the root's children: depth 1). */
  readonly expandedDepth?: number;
}

const DEFAULTS: Required<JsonTreeOptions> = {
  maxDepth: 6,
  maxEntries: 200,
  priorityKeys: ['kind', 'seq', 'ts'],
  collapseStringsOver: 2_048,
  expandedDepth: 2,
};

/** The entries of an object or array, priority keys first, and how many were left out. */
export function treeEntries(
  value: object,
  options: Pick<Required<JsonTreeOptions>, 'maxEntries' | 'priorityKeys'>,
): { readonly entries: [string, unknown][]; readonly hidden: number } {
  const all: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  if (!Array.isArray(value)) {
    const first = options.priorityKeys.filter((key) => Object.hasOwn(value, key));
    all.sort(([a], [b]) => {
      const ai = first.indexOf(a);
      const bi = first.indexOf(b);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }
  return {
    entries: all.slice(0, options.maxEntries),
    hidden: Math.max(0, all.length - options.maxEntries),
  };
}

function LongString({ value, cap }: { readonly value: string; readonly cap: number }): ReactNode {
  const [open, setOpen] = useState(false);
  if (value.length <= cap || open) {
    return <span className="type-engine break-all text-ink">{JSON.stringify(value)}</span>;
  }
  return (
    <span className="inline-flex flex-wrap items-baseline gap-2">
      <span className="type-engine break-all text-ink">{JSON.stringify(value.slice(0, cap))}…</span>
      <Button
        size="sm"
        variant="quiet"
        onPress={() => {
          setOpen(true);
        }}
      >
        Show all ({Math.ceil(value.length / 1024)} K characters)
      </Button>
    </span>
  );
}

function Scalar({ value, cap }: { readonly value: unknown; readonly cap: number }): ReactNode {
  if (typeof value === 'string') return <LongString value={value} cap={cap} />;
  if (value === null || value === undefined)
    return <span className="type-engine text-ink-2">null</span>;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="type-engine text-ink">{String(value)}</span>;
  }
  return <span className="type-engine text-ink-2">{typeof value}</span>;
}

function Node({
  label,
  value,
  depth,
  options,
}: {
  readonly label: string | null;
  readonly value: unknown;
  readonly depth: number;
  readonly options: Required<JsonTreeOptions>;
}): ReactNode {
  const isContainer = value !== null && typeof value === 'object';
  const key = label === null ? null : <span className="type-engine text-ink-2">{label}: </span>;
  if (!isContainer) {
    return (
      <div data-json-key={label ?? ''} className="flex flex-wrap items-baseline">
        {key}
        <Scalar value={value} cap={options.collapseStringsOver} />
      </div>
    );
  }
  const container = value;
  const size = Array.isArray(container) ? container.length : Object.keys(container).length;
  const summary = Array.isArray(container) ? `[${String(size)}]` : `{${String(size)}}`;
  if (depth >= options.maxDepth) {
    return (
      <div data-json-key={label ?? ''} className="flex flex-wrap items-baseline">
        {key}
        <span className="type-engine text-ink-2">{summary} …</span>
      </div>
    );
  }
  const { entries, hidden } = treeEntries(container, options);
  const children = (
    <ul className="flex flex-col gap-0.5">
      {entries.map(([childKey, childValue]) => (
        <li key={childKey}>
          <Node label={childKey} value={childValue} depth={depth + 1} options={options} />
        </li>
      ))}
      {hidden > 0 ? (
        <li data-part="more" className="text-ink-2">
          +{hidden} more
        </li>
      ) : null}
    </ul>
  );
  if (label === null) return children;
  return (
    <Disclosure data-json-key={label} defaultExpanded={depth < options.expandedDepth}>
      <DisclosureTrigger className="h-7">
        <span className="type-engine text-ink-2">{label}</span>
        <span className="type-engine text-ink-2">{summary}</span>
      </DisclosureTrigger>
      <DisclosurePanel className="pl-4">{children}</DisclosurePanel>
    </Disclosure>
  );
}

export interface EventInspectorProps extends JsonTreeOptions {
  readonly value: unknown;
  /** An accessible name for the tree. */
  readonly label?: string;
  readonly className?: string;
}

/** See the module comment. */
export function EventInspector({
  value,
  label,
  className,
  ...options
}: EventInspectorProps): ReactNode {
  const resolved: Required<JsonTreeOptions> = { ...DEFAULTS, ...options };
  return (
    <div
      role="group"
      aria-label={label ?? 'Event details'}
      data-part="event-inspector"
      className={cn('flex flex-col gap-1 text-body', className)}
    >
      <Node label={null} value={value} depth={0} options={resolved} />
    </div>
  );
}
