import { Link, useRouterState } from '@tanstack/react-router';
import { useId, type ReactNode } from 'react';

import { locate, type NavGroup, type NavSection } from '../navigation.js';

/** The page column (Interface Study 01): 1272px wide at most, centred. */
const COLUMN = 'mx-auto w-full max-w-318 px-6 pt-9 pb-18';

const TAB =
  '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-0.5 py-2.5 text-caption font-medium text-ink-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:border-ink aria-[current=page]:font-semibold aria-[current=page]:text-ink';

const MENU_LINK =
  'flex items-center rounded-control px-2.5 py-1.5 text-caption text-ink-2 hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-accent aria-[current=page]:bg-surface aria-[current=page]:font-semibold aria-[current=page]:text-ink aria-[current=page]:ring-1 aria-[current=page]:ring-rule';

function currentPage(pathname: string, path: string): { 'aria-current'?: 'page' } {
  return pathname === path ? { 'aria-current': 'page' } : {};
}

/** Library: the section's name over a row of tabs. */
function Tabs({
  section,
  pathname,
}: {
  readonly section: NavSection;
  readonly pathname: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <p className="type-label text-ink-3">{section.label}</p>
      <nav aria-label={section.label} className="flex flex-wrap gap-7 border-b border-rule">
        {section.groups.flatMap((group) =>
          group.links.map((link) => (
            <Link
              key={link.path}
              to={link.path}
              className={TAB}
              activeProps={{}}
              {...currentPage(pathname, link.path)}
            >
              {link.label}
            </Link>
          )),
        )}
      </nav>
    </div>
  );
}

function MenuGroup({
  group,
  pathname,
}: {
  readonly group: NavGroup;
  readonly pathname: string;
}): ReactNode {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="type-label px-2.5 text-ink-3">
        {group.label}
      </p>
      <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
        {group.links.map((link) => (
          <li key={link.path}>
            <Link
              to={link.path}
              className={MENU_LINK}
              activeProps={{}}
              {...currentPage(pathname, link.path)}
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Frames the routed page for its section: the live cockpit gets the whole
 * window, Library pages sit under their tabs, Settings pages beside the
 * grouped menu (which stacks above the page on a narrow window), and every
 * other page in the centred column.
 */
export function SectionFrame({ children }: { readonly children: ReactNode }): ReactNode {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const location = locate(pathname);
  const section = location?.section;
  switch (section?.layout) {
    case 'full':
      return <div className="px-6 py-8">{children}</div>;
    case 'tabs':
      return (
        <div className={`${COLUMN} flex flex-col gap-7`}>
          <Tabs section={section} pathname={pathname} />
          {children}
        </div>
      );
    case 'side-menu':
      return (
        <div className={`${COLUMN} flex flex-wrap items-start gap-x-12 gap-y-8`}>
          <nav aria-label={section.label} className="flex flex-[1_1_12.5rem] flex-col gap-5">
            {section.groups.map((group) => (
              <MenuGroup key={group.label} group={group} pathname={pathname} />
            ))}
          </nav>
          <div className="min-w-0 flex-[999_1_35rem]">{children}</div>
        </div>
      );
    default:
      return <div className={COLUMN}>{children}</div>;
  }
}
