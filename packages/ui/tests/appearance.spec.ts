import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPEARANCE,
  appearanceAttributes,
  applyAppearance,
  parseAppearance,
} from '../src/appearance.js';

describe('@no-llm Drshya appearance contract', () => {
  describe('appearanceAttributes', () => {
    it('omits data-theme for the system theme', () => {
      expect(appearanceAttributes({ theme: 'system', surfaces: 'glass' })).toEqual({
        'data-surfaces': 'glass',
      });
    });

    it('sets data-theme for an explicit theme', () => {
      expect(appearanceAttributes({ theme: 'dark', surfaces: 'solid' })).toEqual({
        'data-theme': 'dark',
        'data-surfaces': 'solid',
      });
    });
  });

  describe('applyAppearance', () => {
    it('removes data-theme for system', () => {
      const root = document.createElement('div');
      root.setAttribute('data-theme', 'dark');

      applyAppearance(root, { theme: 'system', surfaces: 'glass' });

      expect(root.hasAttribute('data-theme')).toBe(false);
      expect(root.getAttribute('data-surfaces')).toBe('glass');
    });

    it.each(['light', 'dark'] as const)('sets data-theme="%s"', (theme) => {
      const root = document.createElement('div');

      applyAppearance(root, { theme, surfaces: 'glass' });

      expect(root.getAttribute('data-theme')).toBe(theme);
    });

    it('toggles data-surfaces', () => {
      const root = document.createElement('div');

      applyAppearance(root, { theme: 'light', surfaces: 'solid' });
      expect(root.getAttribute('data-surfaces')).toBe('solid');

      applyAppearance(root, { theme: 'light', surfaces: 'glass' });
      expect(root.getAttribute('data-surfaces')).toBe('glass');
    });

    it('is idempotent', () => {
      const root = document.createElement('div');
      const appearance = { theme: 'dark', surfaces: 'solid' } as const;

      applyAppearance(root, appearance);
      const once = root.outerHTML;
      applyAppearance(root, appearance);

      expect(root.outerHTML).toBe(once);
    });

    it('leaves unrelated attributes alone', () => {
      const root = document.createElement('div');
      root.setAttribute('lang', 'en');

      applyAppearance(root, DEFAULT_APPEARANCE);

      expect(root.getAttribute('lang')).toBe('en');
    });
  });

  describe('parseAppearance', () => {
    it('defaults to the system theme and glass surfaces', () => {
      expect(DEFAULT_APPEARANCE).toEqual({ theme: 'system', surfaces: 'glass' });
      expect(parseAppearance(null, null)).toEqual(DEFAULT_APPEARANCE);
    });

    it('accepts every known value', () => {
      expect(parseAppearance('dark', 'solid')).toEqual({ theme: 'dark', surfaces: 'solid' });
      expect(parseAppearance('light', 'glass')).toEqual({ theme: 'light', surfaces: 'glass' });
      expect(parseAppearance('system', 'solid')).toEqual({ theme: 'system', surfaces: 'solid' });
    });

    it('falls back per field on untrusted input', () => {
      expect(parseAppearance('DARK', 'opaque')).toEqual(DEFAULT_APPEARANCE);
      expect(parseAppearance('dark', '<script>')).toEqual({ theme: 'dark', surfaces: 'glass' });
      expect(parseAppearance('', 'solid')).toEqual({ theme: 'system', surfaces: 'solid' });
    });
  });
});
