import { Link } from '@tanstack/react-router';
import { Bindu } from '@yantra/ui';
import type { ReactNode } from 'react';

import type { NavEntry } from '../nav-registry.js';

import { useShellBindu } from './bindu-store.js';

export interface TopBarProps {
  readonly nav: readonly NavEntry[];
}

/**
 * The product name, the Bindu and the registered navigation. The Bindu shows
 * what the shell's store says; the cockpit drives it while a run is on screen.
 */
export function TopBar({ nav }: TopBarProps): ReactNode {
  const bindu = useShellBindu();
  return (
    <header className="flex items-center gap-4 border-b border-rule bg-surface px-4 py-2">
      <div className="flex items-center gap-2">
        <Bindu state={bindu.state} {...(bindu.label === undefined ? {} : { label: bindu.label })} />
        <span className="font-semibold text-ink">Yantra</span>
      </div>
      <nav aria-label="Main">
        <ul className="flex items-center gap-1">
          {nav.map((entry) => (
            <li key={entry.path}>
              <Link
                to={entry.path}
                className="rounded-chip px-2 py-1 text-caption text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
                activeProps={{ 'aria-current': 'page', className: 'text-ink' }}
                activeOptions={{ exact: true }}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
