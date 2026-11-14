/**
 * The text viewer (FEAT-066): a small plain-text artifact, as escaped text.
 */

import type { ReactNode } from 'react';

/** See the module comment. */
export function TextViewer({
  text,
  label,
}: {
  readonly text: string;
  readonly label: string;
}): ReactNode {
  return (
    <pre
      aria-label={label}
      tabIndex={0}
      className="type-engine max-h-[40rem] overflow-auto whitespace-pre-wrap break-words rounded-control border border-rule bg-sunken p-3 text-ink"
    >
      {text}
    </pre>
  );
}
