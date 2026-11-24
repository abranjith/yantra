import { Outlet } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';

import { InterventionsProvider } from '../../features/interventions/interventions-context.js';
import { useConnection, type ConnectionStore } from '../../host/connection-store.js';

import { BinduProvider, BinduStore } from './bindu-store.js';
import { ConnectionBanner } from './ConnectionBanner.js';
import { SectionFrame } from './SectionFrame.js';
import { SessionEnded } from './SessionEnded.js';
import { AppToasts } from './toasts.js';
import { TopBar } from './TopBar.js';

export interface AppShellProps {
  readonly store?: ConnectionStore;
  /** The routed page; defaults to the router outlet. */
  readonly children?: ReactNode;
}

/** The app frame: top bar, connection banner and the routed page in its section's frame. */
export function AppShell({ store, children }: AppShellProps): ReactNode {
  const state = useConnection(store);
  const [bindu] = useState(() => new BinduStore());
  const ended = state.status === 'session_ended' || state.status === 'incompatible';
  return (
    <BinduProvider store={bindu}>
      <InterventionsProvider>
        <AppToasts>
          <div className="flex min-h-screen flex-col bg-bg text-ink">
            <TopBar live={!ended} />
            <ConnectionBanner {...(store === undefined ? {} : { store })} />
            {ended ? (
              <SessionEnded
                {...(state.status === 'incompatible'
                  ? { detail: `The running app is Yantra ${state.hostVersion}.` }
                  : {})}
              />
            ) : (
              <main className="flex-1">
                <SectionFrame>{children ?? <Outlet />}</SectionFrame>
              </main>
            )}
          </div>
        </AppToasts>
      </InterventionsProvider>
    </BinduProvider>
  );
}
