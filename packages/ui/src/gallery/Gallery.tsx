import { useEffect, useState, type ReactNode } from 'react';

import { appearanceAttributes, parseAppearance, type Appearance } from '../appearance.js';

import { GALLERY_ENTRIES, type GalleryEntry } from './entries.js';

export interface GalleryProps {
  /** A query string such as `?entry=button&theme=dark&surfaces=solid`. */
  readonly search: string;
  /** Overrides the entry list; tests use it. */
  readonly entries?: readonly GalleryEntry[];
}

export interface GalleryLocation {
  readonly entry: string | null;
  readonly appearance: Appearance;
}

/** Reads the gallery's state from a query string; unknown values fall back. */
export function parseGallerySearch(search: string): GalleryLocation {
  const params = new URLSearchParams(search);
  const entry = params.get('entry');
  return {
    entry: entry === null || entry === '' ? null : entry,
    appearance: parseAppearance(params.get('theme'), params.get('surfaces')),
  };
}

/** The query string that opens an entry in an appearance. */
export function gallerySearch(entry: string, appearance: Appearance): string {
  return `?${new URLSearchParams({ entry, theme: appearance.theme, surfaces: appearance.surfaces }).toString()}`;
}

/** Resolves once web fonts have loaded; immediately where the API is absent (jsdom). */
function fontsReady(): Promise<unknown> {
  return 'fonts' in document ? document.fonts.ready : Promise.resolve();
}

function EntrySection({ entry }: { readonly entry: GalleryEntry }): ReactNode {
  const headingId = `gallery-entry-${entry.id}`;
  return (
    <section
      data-gallery-entry={entry.id}
      aria-labelledby={headingId}
      className="flex flex-col gap-4 bg-bg p-6 text-ink"
    >
      <h2 id={headingId} className="type-label text-ink-2">
        {entry.title}
      </h2>
      {entry.render()}
    </section>
  );
}

function EntryIndex({
  entries,
  appearance,
  unknown,
}: {
  readonly entries: readonly GalleryEntry[];
  readonly appearance: Appearance;
  readonly unknown: string | null;
}): ReactNode {
  return (
    <nav aria-label="Gallery entries" className="flex flex-col gap-4 p-6">
      {unknown === null ? null : (
        <p role="status" className="text-signal-failed-ink">
          Unknown entry “{unknown}”. Choose one below.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a className="text-accent-ink underline" href={gallerySearch(entry.id, appearance)}>
              {entry.title}
            </a>{' '}
            <span className="type-engine text-ink-2">{entry.id}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The Drshya gallery (spec D3, S5): renders one entry, or the entry index, in
 * the appearance named by `search`. It reads nothing from `window.location`,
 * so FEAT-065 can mount it at `/gallery` and tests can drive it directly.
 *
 * Sets `data-gallery-ready` once fonts have loaded, which the harness waits
 * for before taking a screenshot.
 */
export function Gallery({ search, entries = GALLERY_ENTRIES }: GalleryProps): ReactNode {
  const location = parseGallerySearch(search);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void fontsReady().then(() => {
      if (live) {
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  const selected =
    location.entry === null ? undefined : entries.find((entry) => entry.id === location.entry);

  return (
    <div
      {...appearanceAttributes(location.appearance)}
      data-gallery-ready={ready ? '' : undefined}
      className="min-h-screen bg-bg font-sans text-ink"
    >
      <main>
        <h1 className="sr-only">Drshya gallery</h1>
        {selected === undefined ? (
          <EntryIndex entries={entries} appearance={location.appearance} unknown={location.entry} />
        ) : (
          <EntrySection entry={selected} />
        )}
      </main>
    </div>
  );
}
