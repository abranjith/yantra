import { Link } from '@tanstack/react-router';
import { Bindu } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useOpenInboxCount } from '../../features/interventions/interventions-context.js';
import type { NavEntry } from '../nav-registry.js';

import { useShellBindu, type ShellBindu } from './bindu-store.js';

/** The route the Inbox badge belongs to. */
export const INBOX_PATH = '/inbox';

/** What `count` open Inbox items read as, e.g. "2 items need you". */
export function openItemsLabel(count: number): string {
  return `${count} ${openItemsTail(count)}`;
}

/** The words after the count: "item needs you" or "items need you". */
export function openItemsTail(count: number): string {
  return count === 1 ? 'item needs you' : 'items need you';
}

/**
 * The Bindu turns Rani while the Inbox has open items (plan §6), whatever the
 * cockpit is showing; with nothing open, it shows the shell's own state.
 */
export function topBarBindu(shell: ShellBindu, openItems: number): ShellBindu {
  if (openItems === 0) return shell;
  return { state: 'attention', label: `Yantra status: ${openItemsLabel(openItems)}` };
}

export interface TopBarProps {
  readonly nav: readonly NavEntry[];
}

/**
 * The product name, the Bindu and the registered navigation. The Bindu shows
 * what the shell's store says (the cockpit drives it while a run is on
 * screen) unless the Inbox has open items; the Inbox link carries their count.
 */
export function TopBar({ nav }: TopBarProps): ReactNode {
  const openItems = useOpenInboxCount();
  const bindu = topBarBindu(useShellBindu(), openItems);
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
                {entry.path === INBOX_PATH && openItems > 0 ? (
                  // The name is the visible text plus a spoken tail ("Inbox 2 items
                  // need you"), so it always contains what is shown (WCAG 2.5.3).
                  <>
                    {' '}
                    <span
                      data-inbox-badge
                      className="ml-1 inline-flex min-w-5 items-center justify-center rounded-full border border-signal-needs-you bg-surface px-1.5 type-engine text-micro text-signal-needs-you-ink"
                    >
                      {openItems}
                    </span>
                    <span className="sr-only"> {openItemsTail(openItems)}</span>
                  </>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
