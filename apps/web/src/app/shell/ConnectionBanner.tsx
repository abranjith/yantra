import { useEffect, useState, type ReactNode } from 'react';

import { useConnection, type ConnectionStore } from '../../host/connection-store.js';

/** The banner text for a connection state; empty when connected. */
export function connectionMessage(state: ReturnType<typeof useConnection>, now: number): string {
  switch (state.status) {
    case 'connecting':
      return 'Connecting to Yantra…';
    case 'connected':
      return '';
    case 'disconnected': {
      const seconds = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
      return seconds > 0
        ? `Disconnected from Yantra. Reconnecting in ${seconds} s.`
        : 'Disconnected from Yantra. Reconnecting…';
    }
    case 'session_ended':
      return 'Session ended — run `yantra ui` to reopen.';
    case 'incompatible':
      return `This window cannot talk to Yantra ${state.hostVersion}. Run \`yantra ui\` to reopen.`;
  }
}

export interface ConnectionBannerProps {
  readonly store?: ConnectionStore;
  readonly now?: () => number;
}

/**
 * Announces connection changes through a polite live region (§9). It never
 * moves focus; the region is always present so announcements are not lost.
 */
export function ConnectionBanner({ store, now = Date.now }: ConnectionBannerProps): ReactNode {
  const state = useConnection(store);
  const [tick, setTick] = useState(now());
  useEffect(() => {
    if (state.status !== 'disconnected') return undefined;
    const handle = window.setInterval(() => {
      setTick(now());
    }, 1_000);
    return () => {
      window.clearInterval(handle);
    };
  }, [state, now]);
  const message = connectionMessage(state, Math.max(tick, now()));
  return (
    <div
      role="status"
      aria-live="polite"
      data-status={state.status}
      className={
        message === '' ? 'sr-only' : 'border-b border-rule bg-sunken px-4 py-2 text-sm text-ink-2'
      }
    >
      {message}
    </div>
  );
}
