import { Outlet } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { useConnection, type ConnectionStore } from '../../host/connection-store.js';
import { navRegistry, type NavRegistry } from '../nav-registry.js';

import { ConnectionBanner } from './ConnectionBanner.js';
import { SessionEnded } from './SessionEnded.js';
import { TopBar } from './TopBar.js';

export interface AppShellProps {
  readonly store?: ConnectionStore;
  readonly nav?: NavRegistry;
  /** The routed page; defaults to the router outlet. */
  readonly children?: ReactNode;
}

/** The app frame: top bar, connection banner and the routed page. */
export function AppShell({ store, nav = navRegistry, children }: AppShellProps): ReactNode {
  const state = useConnection(store);
  return (
    <div className="flex min-h-screen flex-col bg-bg text-ink">
      <TopBar nav={nav.entries()} />
      <ConnectionBanner {...(store === undefined ? {} : { store })} />
      {state.status === 'session_ended' || state.status === 'incompatible' ? (
        <SessionEnded
          {...(state.status === 'incompatible'
            ? { detail: `The running app is Yantra ${state.hostVersion}.` }
            : {})}
        />
      ) : (
        <main className="flex-1 px-6 py-8">{children ?? <Outlet />}</main>
      )}
    </div>
  );
}
