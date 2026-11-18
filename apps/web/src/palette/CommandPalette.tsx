import { COMMAND_REGISTRY, defaultShellFor } from '@yantra/protocol/commands';
import { Button, Dialog, TextField } from '@yantra/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { PARITY_MANIFEST } from '../parity/manifest.js';

import { interpret, type PaletteOutcome } from './palette-model.js';

export function CommandPalette({
  platform = 'linux',
  onOutcome,
}: {
  readonly platform?: string;
  readonly onOutcome?: (outcome: PaletteOutcome) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<PaletteOutcome | null>(null);
  const previous = useRef<HTMLElement | null>(null);
  const shell = defaultShellFor(platform);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        previous.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const close = (): void => {
    setOpen(false);
    queueMicrotask(() => previous.current?.focus());
  };
  const run = (): void => {
    const next = interpret(text, shell, COMMAND_REGISTRY, PARITY_MANIFEST);
    setOutcome(next);
    onOutcome?.(next);
  };
  return (
    <>
      {open ? (
        <Dialog
          title="Command palette"
          isOpen
          onOpenChange={(value) => {
            if (!value) close();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              run();
            }}
            className="flex flex-col gap-4"
          >
            <TextField
              autoFocus
              label="Yantra command"
              value={text}
              onChange={setText}
              description="Type one Yantra command. Shell operators and expansions are refused."
            />
            <div aria-live="polite" className="text-ink-2">
              {outcome === null ? '' : outcome.state.replaceAll('_', ' ')}
            </div>
            <Button type="submit">Interpret</Button>
            <Button variant="secondary" onPress={close}>
              Close
            </Button>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
