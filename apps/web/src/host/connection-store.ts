/**
 * The app's connection to its host, as a `useSyncExternalStore` store
 * (FEAT-065 TASK-011).
 */

import { useSyncExternalStore } from 'react';

/** Where the connection stands. */
export type ConnectionState =
  | { readonly status: 'connecting' }
  | { readonly status: 'connected' }
  /** The socket dropped; it retries at `retryAt` (epoch ms). */
  | { readonly status: 'disconnected'; readonly retryAt: number }
  /** The window's session is gone; only `yantra ui` opens a new one. */
  | { readonly status: 'session_ended' }
  /** The host speaks a channel version this page does not. */
  | { readonly status: 'incompatible'; readonly hostVersion: string };

type Listener = () => void;

/** A minimal external store for {@link ConnectionState}. */
export class ConnectionStore {
  private state: ConnectionState = { status: 'connecting' };
  private readonly listeners = new Set<Listener>();

  public readonly getSnapshot = (): ConnectionState => this.state;

  public readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Moves to `next`; a session that ended stays ended. */
  public set(next: ConnectionState): void {
    if (this.state.status === 'session_ended') return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The app-wide store. */
export const connectionStore = new ConnectionStore();

/** Subscribes a component to `store`. */
export function useConnection(store: ConnectionStore = connectionStore): ConnectionState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
