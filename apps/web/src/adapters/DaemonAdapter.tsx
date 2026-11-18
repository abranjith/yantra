import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger } from '@yantra/ui';
import type { ReactNode } from 'react';

import { GeneratedForm } from '../generated/GeneratedForm.js';

export function DaemonAdapter({ cwd }: { readonly cwd: string }): ReactNode {
  const start = findLeaf(['daemon', 'start']);
  const stop = findLeaf(['daemon', 'stop']);
  if (start === undefined || stop === undefined) return null;
  return (
    <div className="flex gap-3">
      <DialogTrigger>
        <Button>Start</Button>
        <Dialog title="Start scheduler">
          <GeneratedForm command={start} cwd={cwd} />
        </Dialog>
      </DialogTrigger>
      <DialogTrigger>
        <Button variant="secondary">Stop</Button>
        <Dialog title="Stop scheduler?">
          <p>Scheduled runs will not fire until you start it again.</p>
          <GeneratedForm command={stop} cwd={cwd} />
        </Dialog>
      </DialogTrigger>
    </div>
  );
}
