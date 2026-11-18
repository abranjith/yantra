import { findLeaf } from '@yantra/protocol/commands';
import { Button, Dialog, DialogTrigger } from '@yantra/ui';
import type { ReactNode } from 'react';

import { GeneratedForm } from '../generated/GeneratedForm.js';

export function ConfigEditAdapter({ cwd }: { readonly cwd: string }): ReactNode {
  const command = findLeaf(['config', 'edit']);
  if (command === undefined) return null;
  return (
    <DialogTrigger>
      <Button variant="secondary">Edit config.yaml</Button>
      <Dialog title="Edit config.yaml">
        <p className="text-ink-2">
          The terminal equivalent opens $EDITOR. The app sends edited text through the input
          collector, never argv.
        </p>
        <GeneratedForm command={command} cwd={cwd} />
      </Dialog>
    </DialogTrigger>
  );
}
