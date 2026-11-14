/**
 * The JSON viewer (FEAT-066): a collapsible, depth-limited tree over a parsed
 * JSON value, with strings over 2 KiB collapsed. It is the Drshya
 * EventInspector with no priority keys, so every value is escaped text.
 */

import { EventInspector } from '@yantra/ui';
import type { ReactNode } from 'react';

export interface JsonViewerProps {
  readonly value: unknown;
  readonly label: string;
}

/** See the module comment. */
export function JsonViewer({ value, label }: JsonViewerProps): ReactNode {
  return (
    <EventInspector
      value={value}
      label={label}
      priorityKeys={[]}
      maxDepth={8}
      maxEntries={500}
      expandedDepth={2}
    />
  );
}
