/**
 * One interventions store per app window (REV-005, plan §6 and D5).
 *
 * The shell owns it, so the window subscribes to interventions and sends its
 * attendance heartbeat on every page, not only while the Inbox is open. The
 * top bar reads its count for the Inbox badge and the Rani Bindu; the Inbox
 * page and its consent cards answer through the same store.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { useOptionalRpc } from '../../host/app-rpc.js';

import { InterventionsStore } from './interventions-store.js';

const InterventionsContext = createContext<InterventionsStore | null>(null);

/** Starts the window's interventions store; without a host connection it provides none. */
export function InterventionsProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const rpc = useOptionalRpc();
  const [store] = useState(() => (rpc === null ? null : new InterventionsStore(rpc)));
  useEffect(() => store?.start(), [store]);
  return <InterventionsContext.Provider value={store}>{children}</InterventionsContext.Provider>;
}

/** The window's interventions store; throws outside {@link InterventionsProvider}. */
export function useInterventions(): InterventionsStore {
  const store = useContext(InterventionsContext);
  if (store === null) {
    throw new Error('useInterventions() needs an <InterventionsProvider> with a host connection.');
  }
  return store;
}

const NO_SUBSCRIPTION = (): (() => void) => () => undefined;

/** Open Inbox items right now: 0 while loading, on error, or without a store. */
export function useOpenInboxCount(): number {
  const store = useContext(InterventionsContext);
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? NO_SUBSCRIPTION,
    () => store?.getSnapshot() ?? null,
    () => store?.getSnapshot() ?? null,
  );
  if (snapshot?.error !== null) return 0;
  return snapshot.count;
}
