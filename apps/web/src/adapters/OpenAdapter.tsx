import { Button } from '@yantra/ui';
import type { ReactNode } from 'react';

export function OpenAdapter({
  runId,
  artifact,
  onView,
  onOpen,
  onCopy,
}: {
  readonly runId: string;
  readonly artifact: string;
  readonly onView: () => void;
  readonly onOpen: () => void;
  readonly onCopy: () => void;
}): ReactNode {
  return (
    <div className="flex gap-3" data-run-id={runId} data-artifact={artifact}>
      <Button onPress={onView}>View</Button>
      <Button variant="secondary" onPress={onOpen}>
        Open in system app
      </Button>
      <Button variant="secondary" onPress={onCopy}>
        Copy path
      </Button>
    </div>
  );
}
