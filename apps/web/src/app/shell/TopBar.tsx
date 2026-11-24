import { Link, useRouterState } from '@tanstack/react-router';
import { Bindu, Icon, type BinduState } from '@yantra/ui';
import type { ReactNode } from 'react';

import { useOpenInboxCount } from '../../features/interventions/interventions-context.js';
import { CommandPalette } from '../../palette/CommandPalette.js';
import { locate, MAIN_SECTIONS, SETTINGS_SECTION, type SectionId } from '../navigation.js';

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

/** The word shown beside the Bindu; its accessible name stays on the Bindu itself. */
export const STATUS_WORDS: Readonly<Record<BinduState, string>> = {
  idle: 'Idle',
  live: 'Running',
  attention: 'Needs you',
  thinking: 'Thinking',
  acting: 'Acting',
  needs_you: 'Needs you',
  fulfilled: 'Fulfilled',
};

const NAV_LINK =
  'inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-caption font-medium text-ink-2 hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-sunken aria-[current=page]:font-semibold aria-[current=page]:text-ink';

/** The Yantra mark: the square in the circle around the Ion center point. */
function Mark(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="size-5.5 shrink-0 text-ink">
      <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 3.2 20.8 12 12 20.8 3.2 12Z" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="12" r="2.2" className="fill-accent" />
    </svg>
  );
}

function Wordmark(): ReactNode {
  return (
    <>
      <Mark />
      <span className="type-wordmark text-ink">Yantra</span>
    </>
  );
}

/** The Bindu and its state in a word. */
function Status({ bindu }: { readonly bindu: ShellBindu }): ReactNode {
  const needsYou = bindu.state === 'attention' || bindu.state === 'needs_you';
  return (
    <span
      className={`inline-flex items-center gap-2 px-1.5 text-caption ${
        needsYou ? 'font-semibold text-signal-needs-you-ink' : 'text-ink-2'
      }`}
    >
      <Bindu state={bindu.state} {...(bindu.label === undefined ? {} : { label: bindu.label })} />
      <span aria-hidden="true">{STATUS_WORDS[bindu.state]}</span>
    </span>
  );
}

/** `aria-current` for a section link: the page is anywhere in that section. */
function current(here: SectionId | undefined, id: SectionId): { 'aria-current'?: 'page' } {
  return here === id ? { 'aria-current': 'page' } : {};
}

/** The navigation and controls, while the session is live (they need the router). */
function LiveControls({ openItems }: { readonly openItems: number }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const here = locate(pathname)?.section.id;
  return (
    <>
      <nav aria-label="Main">
        <ul className="flex flex-wrap items-center gap-0.5">
          {MAIN_SECTIONS.map((section) => (
            <li key={section.id}>
              <Link
                to={section.path}
                className={NAV_LINK}
                activeProps={{}}
                {...current(here, section.id)}
              >
                {section.label}
                {section.path === INBOX_PATH && openItems > 0 ? (
                  // The name is the visible text plus a spoken tail ("Inbox 2 items
                  // need you"), so it always contains what is shown (WCAG 2.5.3).
                  <>
                    {' '}
                    <span
                      data-inbox-badge
                      className="inline-flex min-w-5 items-center justify-center rounded-full border border-signal-needs-you px-1.5 type-engine text-micro text-signal-needs-you-ink"
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
      <div className="flex-1" />
      <CommandPalette />
    </>
  );
}

function SettingsLink(): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  return (
    <Link
      to={SETTINGS_SECTION.path}
      className={NAV_LINK}
      activeProps={{}}
      {...current(locate(pathname)?.section.id, 'settings')}
    >
      <Icon name="nav.settings" size={16} />
      {SETTINGS_SECTION.label}
    </Link>
  );
}

export interface TopBarProps {
  /**
   * False once the session ended or the host is incompatible: nothing in the
   * app can be reached then, so the bar shows only the wordmark and status.
   */
  readonly live?: boolean;
}

/**
 * The app's top bar (Interface Study 01): the wordmark, the four
 * destinations, the command palette, the Bindu with its state in a word, and
 * Settings. The Bindu shows the shell's store (the cockpit drives it while a
 * run is on screen) unless the Inbox has open items; the Inbox link carries
 * their count.
 */
export function TopBar({ live = true }: TopBarProps): ReactNode {
  const openItems = useOpenInboxCount();
  const bindu = topBarBindu(useShellBindu(), openItems);
  return (
    <header className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-b border-rule bg-surface px-6 py-2.5">
      {live ? (
        <Link to="/mission" className="flex items-center gap-2.5 rounded-control" activeProps={{}}>
          <Wordmark />
        </Link>
      ) : (
        <span className="flex items-center gap-2.5">
          <Wordmark />
        </span>
      )}
      {live ? <LiveControls openItems={openItems} /> : <div className="flex-1" />}
      <Status bindu={bindu} />
      {live ? <SettingsLink /> : null}
    </header>
  );
}
