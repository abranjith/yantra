/**
 * "Show in folder" (FEAT-066): opens the run directory in the system file
 * manager by running `yantra open <run-id> --artifact dir`.
 *
 * With an `invoke` (the host's `command.invoke`, the plan's mutate-worker
 * route for `open`) it is one button. Without one — a read-only host, or an
 * app that cannot build invocations yet — it shows the copyable CLI twin.
 */

import { Button } from '@yantra/ui';
import { useState, type ReactNode } from 'react';

import { CliTwin } from '../run-result/CliTwin.js';

/** The command that shows a run's directory. */
export function showInFolderCommand(runId: string): string {
  return `yantra open ${runId} --artifact dir`;
}

export interface ShowInFolderProps {
  readonly runId: string;
  /** Runs `open <run-id> --artifact dir` through the host; absent when unavailable. */
  readonly invoke?: () => Promise<void>;
}

/** See the module comment. */
export function ShowInFolder({ runId, invoke }: ShowInFolderProps): ReactNode {
  const [failed, setFailed] = useState(false);
  if (invoke === undefined || failed) {
    return <CliTwin command={showInFolderCommand(runId)} label="Show in folder" />;
  }
  return (
    <Button
      size="sm"
      icon="action.openExternal"
      onPress={() => {
        invoke().catch(() => {
          setFailed(true);
        });
      }}
    >
      Show in folder
    </Button>
  );
}
