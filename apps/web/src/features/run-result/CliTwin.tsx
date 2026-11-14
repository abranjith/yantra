/**
 * The CLI twin (FEAT-066): the exact terminal command that does what this
 * screen shows, as copyable text (memory -> General: CLI ↔ app parity).
 */

import { Button } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

export interface CliTwinProps {
  readonly command: string;
  readonly label?: string;
}

/** See the module comment. */
export function CliTwin({ command, label = 'In a terminal' }: CliTwinProps): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2" data-part="cli-twin">
      <span className="type-label text-ink-2">{label}</span>
      <code className="type-engine rounded-chip bg-sunken px-2 py-1 text-ink">{command}</code>
      <Button
        size="sm"
        variant="quiet"
        icon="action.copy"
        aria-label={`Copy ${command}`}
        onPress={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
            },
            () => undefined,
          );
        }}
      />
      <span role="status" aria-live="polite" className="text-caption text-ink-2">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  );
}
