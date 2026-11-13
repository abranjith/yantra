import { Link } from '@tanstack/react-router';
import { Bindu, type BinduState } from '@yantra/ui';
import type { ReactNode } from 'react';

import type { NavEntry } from '../nav-registry.js';

export interface TopBarProps {
  readonly nav: readonly NavEntry[];
  readonly bindu?: BinduState;
}

/** The product name, the Bindu and the registered navigation. */
export function TopBar({ nav, bindu = 'idle' }: TopBarProps): ReactNode {
  return (
    <header className="flex items-center gap-4 border-b border-rule bg-surface px-4 py-2">
      <div className="flex items-center gap-2">
        <Bindu state={bindu} />
        <span className="font-semibold text-ink">Yantra</span>
      </div>
      <nav aria-label="Main">
        <ul className="flex items-center gap-1">
          {nav.map((entry) => (
            <li key={entry.path}>
              <Link
                to={entry.path}
                className="rounded-chip px-2 py-1 text-sm text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
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
