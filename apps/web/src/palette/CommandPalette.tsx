import { useRouter } from '@tanstack/react-router';
import { COMMAND_REGISTRY, defaultShellFor } from '@yantra/protocol/commands';
import { Button, CommandMenu, CommandMenuDialog } from '@yantra/ui';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useToasts } from '../app/shell/toasts.js';
import { readFailure } from '../generated/read-document.js';
import { useRpc } from '../host/app-rpc.js';
import { PARITY_MANIFEST } from '../parity/manifest.js';

import { executePalette } from './execute.js';
import { readCommand } from './palette-model.js';
import { commandText, nothingToRun, paletteSections, type PaletteTarget } from './suggestions.js';

/** This computer's platform, as the command formatter names it. */
function platformOf(): string {
  if (typeof navigator === 'undefined') return 'linux';
  if (navigator.userAgent.includes('Windows')) return 'win32';
  return /Mac|iPhone|iPad/u.test(navigator.userAgent) ? 'darwin' : 'linux';
}

/** The palette shortcut as this computer spells it. */
function shortcutLabel(): string {
  return platformOf() === 'darwin' ? '⌘K' : 'Ctrl K';
}

function Key({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <kbd className="rounded-chip border border-b-2 border-rule-strong bg-surface px-1.5 type-engine text-micro text-ink-2">
      {children}
    </kbd>
  );
}

/** Where a Mission start goes: the composer, in that mode, with the goal filled in. */
export function startPath(target: Extract<PaletteTarget, { kind: 'start' }>): string {
  const search = new URLSearchParams({ mode: target.mode });
  if (target.goal !== undefined) search.set('goal', target.goal);
  return `/mission?${search.toString()}`;
}

/**
 * The command palette: the top bar's "Search or type a command" button, or
 * Ctrl/Cmd+K, opens it.
 *
 * It answers "what can I do here?" before anything is typed (start a run, go
 * somewhere), then searches pages, actions and commands as you type, and
 * offers to Ask, Research or Do what you typed. A `yantra` command line runs
 * exactly as in a terminal; the first result says what it will do, or what
 * it still needs. Dangerous commands take a second Enter.
 */
export function CommandPalette(): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [armed, setArmed] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rpc = useRpc();
  const router = useRouter();
  const toasts = useToasts();
  const previous = useRef<HTMLElement | null>(null);
  const shell = defaultShellFor(platformOf());

  const show = (): void => {
    previous.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  };

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        show();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const command = commandText(query);
  const reading = useMemo(
    () =>
      command === null || command.length === 0
        ? null
        : readCommand(command, shell, COMMAND_REGISTRY, PARITY_MANIFEST),
    [command, shell],
  );
  const outcome = reading?.outcome ?? null;
  const sections = useMemo(
    () =>
      paletteSections(query, {
        command,
        outcome,
        armed: armed !== null && armed === command,
        ...(reading === null ? {} : { line: reading.line, quoted: reading.quoted }),
      }),
    [query, command, outcome, reading, armed],
  );

  const close = (): void => {
    setOpen(false);
    setQuery('');
    setArmed(null);
    setProblem(null);
    queueMicrotask(() => previous.current?.focus());
  };

  const go = (path: string): void => {
    close();
    void router.navigate({ href: path });
  };

  const runCommand = async (): Promise<void> => {
    if (outcome?.state !== 'ready' || command === null) return;
    if (outcome.danger && armed !== command) {
      setArmed(command);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await executePalette(outcome, {
        rpc,
        navigate: (path) => {
          void router.navigate({ href: path });
        },
      });
      if (result?.kind === 'started') {
        toasts?.add({
          title: 'Sent to Yantra',
          // What the result said it would do: the plain words when Yantra quoted the text.
          description:
            sections.flatMap((section) => section.items).find((item) => item.id === 'command:run')
              ?.label ??
            reading?.line ??
            `yantra ${command}`,
          tone: 'info',
        });
      }
      close();
    } catch (error) {
      setProblem(readFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const act = (id: string): void => {
    const item = sections.flatMap((section) => section.items).find((entry) => entry.id === id);
    if (item === undefined || busy) return;
    const target = item.target;
    if (target.kind === 'go') go(target.path);
    else if (target.kind === 'start') go(startPath(target));
    else if (target.kind === 'fill') {
      setQuery(target.text);
      setArmed(null);
      setProblem(null);
    } else void runCommand();
  };

  return (
    <>
      <Button
        variant="secondary"
        icon="action.search"
        className="min-w-64 justify-start bg-sunken font-normal text-ink-3 hover:text-ink"
        size="sm"
        onPress={show}
      >
        <span className="flex-1 text-left">Search or type a command</span>
        <kbd
          aria-hidden="true"
          className="rounded-chip border border-b-2 border-rule-strong bg-surface px-1.5 type-engine text-micro text-ink-2"
        >
          {shortcutLabel()}
        </kbd>
      </Button>
      <CommandMenuDialog
        isOpen={open}
        onOpenChange={(value) => {
          if (!value) close();
        }}
        aria-label="Command palette"
      >
        <CommandMenu
          inputLabel="Search Yantra or type a command"
          listLabel="Suggestions"
          placeholder="Search pages and actions, or type a command"
          inputValue={query}
          onInputChange={(value) => {
            setQuery(value);
            setArmed(null);
            setProblem(null);
          }}
          sections={sections}
          onAction={act}
          onSubmit={() => {
            // Enter with nothing to act on still answers: say why it cannot run.
            const why = nothingToRun(sections);
            if (why !== null) setProblem(why);
          }}
          emptyState="Nothing matches. Try other words, or a command like yantra doctor."
        />
        {problem === null ? null : (
          <p
            role="alert"
            className="border-t border-rule px-4 py-2.5 text-caption text-signal-failed-ink"
          >
            {problem}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-t border-rule bg-sunken px-4 py-2.5 text-caption text-ink-3">
          <span>
            {command === null ? (
              <>
                You can also type a command, like{' '}
                <span className="type-engine text-ink-2">yantra sites add example.com</span>
              </>
            ) : reading?.quoted === true ? (
              'The rest of the line is your question; no quotes needed.'
            ) : (
              'Commands run as they would in a terminal.'
            )}
          </span>
          <span aria-hidden="true" className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Key>↑</Key>
              <Key>↓</Key> choose
            </span>
            <span className="flex items-center gap-1">
              <Key>Enter</Key> open
            </span>
            <span className="flex items-center gap-1">
              <Key>Esc</Key> close
            </span>
          </span>
        </div>
      </CommandMenuDialog>
    </>
  );
}
