import type { ReactNode } from 'react';

import { locate } from '../navigation.js';

export interface PageHeaderProps {
  /** The page's name: the one `h1`. */
  readonly title: ReactNode;
  /** What the page is for, in a sentence. */
  readonly description?: ReactNode;
  /**
   * The small label above the title. Defaults to where the page sits in the
   * navigation ("Settings · Setup"); Library pages have their section over
   * the tabs already, so they get none.
   */
  readonly eyebrow?: string | null;
  /** Where the page sits, for the default eyebrow. */
  readonly path?: string;
  /** The page's actions: at most one `primary`, the rest `secondary`. */
  readonly actions?: ReactNode;
  /** Beside the title, for live counts and status (`aria-live` is the caller's). */
  readonly aside?: ReactNode;
}

/** The default eyebrow for `path`: "Settings · Setup", or none. */
export function eyebrowFor(path: string | undefined): string | null {
  if (path === undefined) return null;
  const location = locate(path);
  if (location === null || location.section.layout === 'tabs') return null;
  return location.group === null ? null : `${location.section.label} · ${location.group.label}`;
}

/**
 * The page header every page shares (Interface Study 01): an eyebrow, the
 * title in the expanded headline voice, a one-line description, then the
 * page's actions.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  path,
  actions,
  aside,
}: PageHeaderProps): ReactNode {
  const label = eyebrow === undefined ? eyebrowFor(path) : eyebrow;
  return (
    <header className="flex flex-col gap-2.5">
      {label === null ? null : <p className="type-label text-ink-3">{label}</p>}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="type-headline text-ink">{title}</h1>
        {aside}
      </div>
      {description === undefined ? null : (
        <p className="max-w-[64ch] text-lead text-ink-2">{description}</p>
      )}
      {actions === undefined ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
