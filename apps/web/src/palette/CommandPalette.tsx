import { COMMAND_REGISTRY, defaultShellFor } from '@yantra/protocol/commands';
import { Button, Dialog, TextField } from '@yantra/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';

import { executePalette } from './execute.js';
import { interpret, type PaletteOutcome } from './palette-model.js';

/** The palette shortcut as this computer spells it. */
function shortcutLabel(): string {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.userAgent)
    ? '⌘K'
    : 'Ctrl K';
}

/**
 * The command palette: the top bar's "Type a command" chip, or Ctrl/Cmd+K,
 * opens it; it accepts the same syntax as the terminal.
 */
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
        icon="action.command"
        className="min-w-64 justify-start bg-sunken font-normal text-ink-3 hover:text-ink"
        size="sm"
        onPress={() => {
          previous.current = document.activeElement as HTMLElement | null;
          setOpen(true);
        }}
      >
        <span className="flex-1 text-left">Type a command</span>
        <kbd
          aria-hidden="true"
          className="rounded-chip border border-b-2 border-rule-strong bg-surface px-1.5 type-engine text-micro text-ink-2"
        >
          {shortcutLabel()}
        </kbd>
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
