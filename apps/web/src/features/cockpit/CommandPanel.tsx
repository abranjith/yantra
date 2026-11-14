/**
 * The Command panel (FEAT-067 TASK-007): the exact command behind this run,
 * copyable for the user's shell.
 *
 * - A run the app launched shows its invocation.
 * - Any other run shows the command rebuilt from its records, labelled
 *   "Reconstructed" (or "Goal only") — supplied by the run's recovery read
 *   (TASK-013/014).
 * - Recovery actions (Resume, Run again) mount here once the run has ended.
 */

import type { CommandInvocation } from '@yantra/protocol';
import type { ReactNode } from 'react';

import { InvocationTwin } from './cli-twin.js';

export interface CommandPanelProps {
  /** What the app launched, when it did. */
  readonly invocation: CommandInvocation | null;
  /** A command rebuilt from the run's records, when there is no invocation. */
  readonly reconstructed?: {
    readonly invocation: CommandInvocation;
    readonly badge: string;
  } | null;
  /** Resume and Run again (TASK-014), once the run has ended. */
  readonly recovery?: ReactNode;
}

/** See the module comment. */
export function CommandPanel({
  invocation,
  reconstructed = null,
  recovery,
}: CommandPanelProps): ReactNode {
  return (
    <div data-instrument="command" className="flex flex-col gap-4">
      {invocation !== null ? (
        <InvocationTwin invocation={invocation} />
      ) : reconstructed !== null ? (
        <InvocationTwin invocation={reconstructed.invocation} badge={reconstructed.badge} />
      ) : (
        <p className="text-ink-2">
          This run was not started from the app. Its command appears here once its record is read.
        </p>
      )}
      {recovery}
    </div>
  );
}
