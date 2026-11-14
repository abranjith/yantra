/**
 * The top-bar Bindu as a shell-owned store (FEAT-067 TASK-003).
 *
 * The shell creates one store per mounted app and renders the Bindu from it;
 * the cockpit drives it while a run is on screen and hands it back to idle
 * when it unmounts. There is no module-level instance.
 */

import type { BinduState } from '@yantra/ui';
import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

/** What the top-bar Bindu shows. */
export interface ShellBindu {
  readonly state: BinduState;
  /** Overrides the state's accessible name. */
  readonly label?: string;
}

const IDLE: ShellBindu = Object.freeze({ state: 'idle' });

/** See the module comment. */
export class BinduStore {
  private value: ShellBindu = IDLE;
  private readonly listeners = new Set<() => void>();

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public readonly getSnapshot = (): ShellBindu => this.value;

  /** Shows `next`; a value equal to the current one changes nothing. */
  public set(next: ShellBindu): void {
    if (next.state === this.value.state && next.label === this.value.label) return;
    this.value = next;
    for (const listener of [...this.listeners]) listener();
  }

  /** Back to idle. */
  public reset(): void {
    this.set(IDLE);
  }
}

const BinduContext = createContext<BinduStore | null>(null);

/** Provides the shell's Bindu store. */
export function BinduProvider({
  store,
  children,
}: {
  readonly store: BinduStore;
  readonly children: ReactNode;
}): ReactNode {
  return <BinduContext.Provider value={store}>{children}</BinduContext.Provider>;
}

/** What the top-bar Bindu shows right now (idle without a provider). */
export function useShellBindu(): ShellBindu {
  const store = useContext(BinduContext);
  return useSyncExternalStore(
    store?.subscribe ?? (() => () => undefined),
    store?.getSnapshot ?? (() => IDLE),
    store?.getSnapshot ?? (() => IDLE),
  );
}

/** Drives the top-bar Bindu while the caller is mounted; resets it to idle after. */
export function useDriveBindu(value: ShellBindu): void {
  const store = useContext(BinduContext);
  const { state, label } = value;
  useEffect(() => {
    store?.set(label === undefined ? { state } : { state, label });
  }, [store, state, label]);
  useEffect(
    () => () => {
      store?.reset();
    },
    [store],
  );
}
