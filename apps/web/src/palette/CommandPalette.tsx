import { COMMAND_REGISTRY, defaultShellFor } from '@yantra/protocol/commands';
import { Button, Dialog, TextField } from '@yantra/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';

import { executePalette } from './execute.js';
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
  const rpc = useRpc();
  const [outcome, setOutcome] = useState<PaletteOutcome | null>(null);
  const [dangerArmed, setDangerArmed] = useState(false);
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
    if (next.state !== 'ready') return;
    if (next.danger && !dangerArmed) {
      setDangerArmed(true);
      return;
    }
    void executePalette(next, { rpc, navigate: (path) => window.location.assign(path) }).then(
      close,
    );
  };
  return (
    <>
      <Button
        variant="secondary"
        onPress={() => {
          previous.current = document.activeElement as HTMLElement | null;
          setOpen(true);
        }}
      >
        Command palette
      </Button>
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
              onChange={(value) => {
                setText(value);
                setDangerArmed(false);
              }}
              description="Type one Yantra command. Shell operators and expansions are refused."
            />
            <div aria-live="polite" className="text-ink-2">
              {outcome === null
                ? ''
                : outcome.state === 'secret_in_argv'
                  ? outcome.message
                  : outcome.state.replaceAll('_', ' ')}
            </div>
            <Button type="submit">{dangerArmed ? 'Confirm dangerous command' : 'Run'}</Button>
            <Button variant="secondary" onPress={close}>
              Close
            </Button>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
