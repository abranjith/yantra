/**
 * Where things are in the app.
 *
 * The app is organized by how people use it, not by the CLI's command tree:
 * four destinations in the top bar (Mission, Ledger, Library, Inbox), Library
 * as tabs, and Settings at the end of the bar with a grouped side menu. Every
 * command stays reachable, which the parity manifest checks; this file only
 * decides where a page lives. URLs are unchanged, so links, the palette and
 * deep links keep working.
 *
 * Every path here must be a route; `shell.spec.tsx` checks that, and that
 * every route is either here or in {@link UNLISTED_PATHS}.
 */

/** One page in the navigation. */
export interface NavLink {
  readonly path: string;
  readonly label: string;
}

/** A labelled set of pages: a Library tab row, or a Settings menu group. */
export interface NavGroup {
  readonly label: string;
  readonly links: readonly NavLink[];
}

export type SectionId = 'mission' | 'ledger' | 'library' | 'inbox' | 'settings';

/**
 * How a section frames its pages: `full` uses the whole window (the live
 * cockpit), `page` a centred column, `tabs` a column under a tab row, and
 * `side-menu` a column beside the grouped menu.
 */
export type SectionLayout = 'full' | 'page' | 'tabs' | 'side-menu';

/** A top-bar destination. */
export interface NavSection {
  readonly id: SectionId;
  readonly label: string;
  /** Where its top-bar link goes. */
  readonly path: string;
  /** Paths at or under these belong to it as well (`/runs/<id>` is in the Ledger). */
  readonly prefixes: readonly string[];
  readonly groups: readonly NavGroup[];
  readonly layout: SectionLayout;
}

/** Settings, at the end of the top bar, with a grouped side menu. */
export const SETTINGS_SECTION: NavSection = {
  id: 'settings',
  label: 'Settings',
  path: '/settings/installation',
  prefixes: ['/settings'],
  groups: [
    {
      label: 'Setup',
      links: [
        { path: '/settings/installation', label: 'Installation' },
        { path: '/settings/models', label: 'Models' },
        { path: '/settings/credentials', label: 'Credentials' },
        { path: '/settings/browser', label: 'Browser' },
        { path: '/settings/sites', label: 'Sites' },
        { path: '/settings/data', label: 'Data' },
      ],
    },
    { label: 'You', links: [{ path: '/settings/preferences', label: 'Preferences' }] },
    {
      label: 'System',
      links: [
        { path: '/health', label: 'Health' },
        { path: '/usage', label: 'Usage' },
        { path: '/daemon', label: 'Daemon' },
      ],
    },
  ],
  layout: 'side-menu',
};

/** The main navigation, in top-bar order. */
export const MAIN_SECTIONS: readonly NavSection[] = [
  {
    id: 'mission',
    label: 'Mission',
    path: '/mission',
    // `/` opens Mission.
    prefixes: ['/', '/mission'],
    groups: [],
    layout: 'full',
  },
  { id: 'ledger', label: 'Ledger', path: '/runs', prefixes: ['/runs'], groups: [], layout: 'page' },
  {
    id: 'library',
    label: 'Library',
    path: '/workflows',
    prefixes: [],
    groups: [
      {
        label: 'Library',
        links: [
          { path: '/workflows', label: 'Workflows' },
          { path: '/templates', label: 'Templates' },
          { path: '/schedules', label: 'Schedules' },
        ],
      },
    ],
    layout: 'tabs',
  },
  { id: 'inbox', label: 'Inbox', path: '/inbox', prefixes: ['/inbox'], groups: [], layout: 'page' },
];

/** Every section. */
export const SECTIONS: readonly NavSection[] = [...MAIN_SECTIONS, SETTINGS_SECTION];

/**
 * Real pages that are not in the navigation: each is opened from somewhere
 * else (a Ledger row, Installation's "Run setup again", the setup banner).
 */
export const UNLISTED_PATHS: readonly string[] = [
  '/onboarding',
  '/runs/$runId',
  '/runs/$runId/audit',
  '/runs/$runId/artifacts/$',
  '/mission/runs/$runId',
  '/mission/invocations/$invocationId',
];

/** Where a path sits: its section and, inside Library or Settings, its group and page. */
export interface NavLocation {
  readonly section: NavSection;
  readonly group: NavGroup | null;
  readonly link: NavLink | null;
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || (prefix !== '/' && pathname.startsWith(`${prefix}/`));
}

/** The section, group and page `pathname` belongs to, or null for none. */
export function locate(pathname: string): NavLocation | null {
  for (const section of SECTIONS) {
    for (const group of section.groups) {
      const link = group.links.find((item) => item.path === pathname);
      if (link !== undefined) return { section, group, link };
    }
  }
  const section = SECTIONS.find((item) => item.prefixes.some((prefix) => under(pathname, prefix)));
  return section === undefined ? null : { section, group: null, link: null };
}

/** Every path the navigation links to. */
export function navigationPaths(): readonly string[] {
  return SECTIONS.flatMap((section) => [
    section.path,
    ...section.groups.flatMap((group) => group.links.map((link) => link.path)),
  ]);
}
