import { useState, type Key, type ReactNode } from 'react';

import { cn } from '../lib/cn.js';
import { Button } from '../primitives/Button.js';
import { Select } from '../primitives/Select.js';

/**
 * CliTwin (FEAT-067): the exact `yantra` command this screen runs, for the
 * user's shell, with Copy (memory -> General: CLI ↔ app parity).
 *
 * - The caller formats the command for each shell (FEAT-062
 *   `formatInvocation`); the instrument only displays. A shell that cannot
 *   carry the command (cmd and a line break, say) shows why in words, and
 *   Copy is off for it.
 * - The shell choice starts at the host's own shell (PowerShell on Windows).
 * - Copy writes the exact text through the Clipboard API and tells the caller,
 *   which confirms politely (a toast); the instrument itself is not a live
 *   region, so the cockpit keeps one.
 */

/** A shell a command can be copied for (FEAT-062 `Shell`). */
export type TwinShell = 'posix' | 'powershell' | 'cmd';

/** One shell's rendering: the command, or why it cannot be shown. */
export type TwinFormat = { readonly text: string } | { readonly unavailable: string };

/** The shell names people know. */
export const TWIN_SHELL_LABELS: Readonly<Record<TwinShell, string>> = {
  posix: 'bash / zsh',
  powershell: 'PowerShell',
  cmd: 'Command Prompt (cmd)',
};

const SHELLS: readonly TwinShell[] = ['posix', 'powershell', 'cmd'];

export interface CliTwinProps {
  readonly formatted: Readonly<Record<TwinShell, TwinFormat>>;
  readonly defaultShell: TwinShell;
  /** What the command is, e.g. "In a terminal". */
  readonly label?: string;
  /** A qualifier such as "Reconstructed" for a command rebuilt from old records. */
  readonly badge?: string;
  readonly onCopied?: (text: string, shell: TwinShell) => void;
  readonly onCopyFailed?: (shell: TwinShell) => void;
  readonly className?: string;
}

/** See the module comment. */
export function CliTwin({
  formatted,
  defaultShell,
  label = 'In a terminal',
  badge,
  onCopied,
  onCopyFailed,
  className,
}: CliTwinProps): ReactNode {
  const [shell, setShell] = useState<TwinShell>(defaultShell);
  const current = formatted[shell];
  const text = 'text' in current ? current.text : null;
  return (
    <div
      data-instrument="cli-twin"
      data-shell={shell}
      className={cn('flex flex-col gap-2', className)}
    >
      <div className="flex flex-wrap items-end gap-3">
        <span className="type-label text-ink-2">
          {label}
          {badge === undefined ? null : (
            <span className="ml-2 rounded-chip border border-rule px-1.5 py-0.5 text-caption text-ink-2">
              {badge}
            </span>
          )}
        </span>
        <Select
          label="Shell"
          className="w-56"
          options={SHELLS.map((id) => ({ id, label: TWIN_SHELL_LABELS[id] }))}
          selectedKey={shell}
          onSelectionChange={(key: Key | null) => {
            if (key === 'posix' || key === 'powershell' || key === 'cmd') setShell(key);
          }}
        />
      </div>
      <div className="flex items-start gap-2">
        {text === null ? (
          <p className="flex-1 text-signal-partial-ink" data-part="unavailable">
            {'unavailable' in current ? current.unavailable : ''}
          </p>
        ) : (
          <code
            data-part="command"
            className="type-engine min-w-0 flex-1 rounded-chip bg-sunken px-2 py-1 break-all whitespace-pre-wrap text-ink"
          >
            {text}
          </code>
        )}
        <Button
          size="sm"
          variant="secondary"
          icon="action.copy"
          isDisabled={text === null}
          onPress={() => {
            if (text === null) return;
            const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
            if (clipboard === undefined) {
              onCopyFailed?.(shell);
              return;
            }
            clipboard.writeText(text).then(
              () => onCopied?.(text, shell),
              () => onCopyFailed?.(shell),
            );
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  );
}
