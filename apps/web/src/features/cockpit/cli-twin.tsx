/**
 * The CLI twin of an invocation (FEAT-067 TASK-007): the command formatted for
 * every shell by FEAT-062's `formatInvocation`, shown by the Drshya CliTwin.
 *
 * Formatting lives here, in the app, and only here; the instrument displays.
 * The default shell is the computer's own (PowerShell on Windows): the app
 * window runs on the same computer as the host, so the browser's platform is
 * the host's.
 */

import type { CommandInvocation } from '@yantra/protocol';
import { defaultShellFor, formatInvocation } from '@yantra/protocol/commands';
import { CliTwin, type TwinFormat, type TwinShell } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useToasts } from '../../app/shell/toasts.js';

const SHELLS: readonly TwinShell[] = ['posix', 'powershell', 'cmd'];

/** The command for each shell, or why that shell cannot carry it. */
export function formatTwin(invocation: CommandInvocation): Record<TwinShell, TwinFormat> {
  const out = {} as Record<TwinShell, TwinFormat>;
  for (const shell of SHELLS) {
    const result = formatInvocation(invocation, shell);
    out[shell] = result.ok ? { text: result.text } : { unavailable: result.detail };
  }
  return out;
}

/** A Node-style platform name from the browser's own platform. */
export function browserPlatform(source: {
  readonly userAgentData?: { readonly platform?: string };
  readonly platform?: string;
  readonly userAgent?: string;
}): string {
  const name = source.userAgentData?.platform ?? source.platform ?? source.userAgent ?? '';
  if (/win/iu.test(name)) return 'win32';
  if (/mac|iphone|ipad/iu.test(name)) return 'darwin';
  return 'linux';
}

/**
 * A display-only invocation for a command the user may run themselves (the
 * waiting-for-you answer): nothing launches it, so it has no real ID or
 * working directory. Commands that take a secret never come through here.
 */
export function displayInvocation(
  path: readonly [string, ...string[]],
  argv: readonly string[],
): CommandInvocation {
  const [first, ...rest] = path;
  return { invocation_id: 'display-only-twin', path: [first, ...rest], argv: [...argv], cwd: '/' };
}

/** The shell a copied command targets on this computer. */
export function hostShell(): TwinShell {
  return defaultShellFor(browserPlatform(typeof navigator === 'undefined' ? {} : navigator));
}

export interface InvocationTwinProps {
  readonly invocation: CommandInvocation;
  readonly label?: string;
  readonly badge?: string;
  readonly defaultShell?: TwinShell;
}

/** The CLI twin of `invocation`, confirming a copy with a polite toast. */
export function InvocationTwin({
  invocation,
  label,
  badge,
  defaultShell = hostShell(),
}: InvocationTwinProps): ReactNode {
  const toasts = useToasts();
  return (
    <CliTwin
      formatted={formatTwin(invocation)}
      defaultShell={defaultShell}
      {...(label === undefined ? {} : { label })}
      {...(badge === undefined ? {} : { badge })}
      onCopied={() => toasts?.add({ title: 'Copied', tone: 'info' })}
      onCopyFailed={() =>
        toasts?.add({
          title: 'Couldn’t copy',
          description: 'Select the command and copy it by hand.',
          tone: 'failed',
        })
      }
    />
  );
}
