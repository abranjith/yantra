import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  GALLERY_ENTRIES,
  Gallery,
  gallerySearch,
  parseGallerySearch,
  type GalleryEntry,
} from '../../src/gallery/index.js';
import { useFixedLayout } from '../support/layout.js';

// table-large renders 10,000 rows: give the virtualizer a viewport.
useFixedLayout();

function wrapper(container: HTMLElement): HTMLElement {
  const element = container.firstElementChild;
  if (!(element instanceof HTMLElement)) {
    throw new Error('Gallery rendered no wrapper');
  }
  return element;
}

describe('@no-llm Drshya gallery', () => {
  describe('entries', () => {
    it('have unique ids', () => {
      const ids = GALLERY_ENTRIES.map((entry) => entry.id);

      expect(new Set(ids).size).toBe(ids.length);
    });

    it('have kebab-case ids, safe for URLs and baseline file names', () => {
      const invalid = GALLERY_ENTRIES.map((entry) => entry.id).filter(
        (id) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id),
      );

      expect(invalid).toEqual([]);
    });

    it('have titles', () => {
      expect(GALLERY_ENTRIES.filter((entry) => entry.title.trim() === '')).toEqual([]);
    });

    it.each(GALLERY_ENTRIES.map((entry) => [entry.id, entry] as const))(
      'renders %s without throwing, inside a labelled section',
      (id, entry) => {
        const { container } = render(
          <Gallery search={gallerySearch(entry.id, { theme: 'dark', surfaces: 'solid' })} />,
        );

        // By attribute, not role: an open overlay entry (Select, Popover)
        // rightly hides the rest of the page from the accessibility tree.
        const section = container.querySelector(`[data-gallery-entry="${id}"]`);
        expect(section?.tagName).toBe('SECTION');
        const headingId = section?.getAttribute('aria-labelledby') ?? '';
        expect(document.getElementById(headingId)?.textContent).toBe(entry.title);
      },
    );

    it('renders deterministically', () => {
      const first = render(<Gallery search="?entry=tokens-pairings" />).container.innerHTML;
      const second = render(<Gallery search="?entry=tokens-pairings" />).container.innerHTML;

      expect(second).toBe(first);
    });
  });

  describe('Gallery', () => {
    it('applies the requested appearance to its own wrapper', () => {
      const { container } = render(
        <Gallery search="?entry=tokens-colors&theme=dark&surfaces=solid" />,
      );

      expect(wrapper(container).getAttribute('data-theme')).toBe('dark');
      expect(wrapper(container).getAttribute('data-surfaces')).toBe('solid');
    });

    it('omits data-theme for the system theme', () => {
      const { container } = render(<Gallery search="?entry=tokens-colors&theme=system" />);

      expect(wrapper(container).hasAttribute('data-theme')).toBe(false);
    });

    it('does not touch the document root', () => {
      render(<Gallery search="?entry=tokens-colors&theme=dark" />);

      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });

    it('marks itself ready once fonts are available', async () => {
      const { container } = render(<Gallery search="?entry=tokens-colors" />);

      await waitFor(() => {
        expect(wrapper(container).hasAttribute('data-gallery-ready')).toBe(true);
      });
    });

    it('renders the entry index when no entry is requested', () => {
      render(<Gallery search="" />);

      const nav = screen.getByRole('navigation', { name: 'Gallery entries' });
      expect(nav.querySelectorAll('a')).toHaveLength(GALLERY_ENTRIES.length);
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the appearance in index links', () => {
      render(<Gallery search="?theme=dark&surfaces=solid" />);

      const link = screen.getByRole('link', { name: 'Semantic colors' });
      expect(link.getAttribute('href')).toBe('?entry=tokens-colors&theme=dark&surfaces=solid');
    });

    it('announces an unknown entry and falls back to the index instead of crashing', () => {
      render(<Gallery search="?entry=no-such-entry" />);

      expect(screen.getByRole('status').textContent).toContain('Unknown entry “no-such-entry”');
      expect(screen.getByRole('navigation', { name: 'Gallery entries' })).toBeDefined();
    });

    it('renders untrusted entry text as text, never markup', () => {
      render(<Gallery search={`?entry=${encodeURIComponent('<img src=x onerror=alert(1)>')}`} />);

      expect(document.querySelector('img')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('accepts an injected entry list', () => {
      const entries: readonly GalleryEntry[] = [
        {
          id: 'probe',
          title: 'Probe',
          primitive: null,
          render: () => <p>probe body</p>,
          interactive: false,
        },
      ];

      render(<Gallery search="?entry=probe" entries={entries} />);

      expect(screen.getByText('probe body')).toBeDefined();
    });
  });

  describe('parseGallerySearch', () => {
    it('reads entry and appearance', () => {
      expect(parseGallerySearch('?entry=button&theme=light&surfaces=solid')).toEqual({
        entry: 'button',
        appearance: { theme: 'light', surfaces: 'solid' },
      });
    });

    it('treats an empty entry as none', () => {
      expect(parseGallerySearch('?entry=').entry).toBeNull();
    });

    it('round-trips through gallerySearch', () => {
      const appearance = { theme: 'dark', surfaces: 'glass' } as const;

      expect(parseGallerySearch(gallerySearch('table-large', appearance))).toEqual({
        entry: 'table-large',
        appearance,
      });
    });
  });
});
