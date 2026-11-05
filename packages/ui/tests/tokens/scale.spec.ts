import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { emitThemeCss } from '../../src/tokens/emit.js';
import {
  CLEARED_NAMESPACES,
  FONT_FAMILIES,
  MOTION,
  RADIUS_SCALE,
  TYPE_SCALE,
} from '../../src/tokens/scale.js';

import { blockBody, declarations, propertyNames } from './css-blocks.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const css = emitThemeCss();
const theme = declarations(blockBody(css, '@theme'));
const root = declarations(blockBody(css, ':root'));
const drshyaCss = readFileSync(resolve(packageRoot, 'src/styles/drshya.css'), 'utf8');

describe('@no-llm Drshya type, radius and motion tokens', () => {
  it('clears every default namespace spec S1 lists', () => {
    for (const namespace of [
      'color',
      'radius',
      'shadow',
      'inset-shadow',
      'drop-shadow',
      'font',
      'text',
      'animate',
    ]) {
      expect(theme).toContain(`--${namespace}-*: initial;`);
    }
    expect(CLEARED_NAMESPACES).toContain('ease');
  });

  it('clears each namespace before declaring its values', () => {
    for (const namespace of CLEARED_NAMESPACES) {
      const clear = theme.indexOf(`--${namespace}-*: initial;`);
      const firstValue = theme.findIndex(
        (line) => line.startsWith(`--${namespace}-`) && !line.startsWith(`--${namespace}-*`),
      );
      expect(clear).toBeGreaterThanOrEqual(0);
      if (firstValue !== -1) {
        expect(clear).toBeLessThan(firstValue);
      }
    }
  });

  it('declares exactly the chip, control, frame and full radii', () => {
    const radii = propertyNames(blockBody(css, '@theme')).filter(
      (name) => name.startsWith('--radius-') && name !== '--radius-*',
    );

    expect(radii).toEqual(['--radius-chip', '--radius-control', '--radius-frame', '--radius-full']);
    expect(theme).toContain('--radius-chip: 4px;');
    expect(theme).toContain('--radius-control: 8px;');
    expect(theme).toContain('--radius-frame: 14px;');
    expect(css).not.toContain('--radius-2xl');
    expect(Object.keys(RADIUS_SCALE)).toEqual(['chip', 'control', 'frame', 'full']);
  });

  it('names the self-hosted Fontsource families first in each stack', () => {
    expect(theme).toContain(`--font-sans: ${FONT_FAMILIES.sans};`);
    expect(theme).toContain(`--font-mono: ${FONT_FAMILIES.mono};`);
    expect(FONT_FAMILIES.sans.startsWith('"Archivo Variable"')).toBe(true);
    expect(FONT_FAMILIES.mono.startsWith('"Martian Mono Variable"')).toBe(true);
  });

  it('matches the brainstorm type scale', () => {
    expect(
      Object.fromEntries(Object.entries(TYPE_SCALE).map(([name, step]) => [name, step.size])),
    ).toEqual({
      micro: '0.72rem',
      caption: '0.8125rem',
      body: '0.9375rem',
      lead: '1.125rem',
      title: '1.5rem',
      headline: '2.25rem',
      display: 'clamp(2.25rem, 1rem + 4vw, 4.1rem)',
    });
    for (const [name, step] of Object.entries(TYPE_SCALE)) {
      expect(theme).toContain(`--text-${name}: ${step.size};`);
      expect(theme).toContain(`--text-${name}--line-height: ${step.lineHeight};`);
    }
  });

  it('declares motion: 120/200/320 ms durations as plain properties and one easing', () => {
    expect(root).toContain('--duration-quick: 120ms;');
    expect(root).toContain('--duration-base: 200ms;');
    expect(root).toContain('--duration-slow: 320ms;');
    expect(theme).toContain(`--ease-standard: ${MOTION.easeStandard};`);
    expect(theme.some((line) => line.startsWith('--duration-'))).toBe(false);
  });

  it('leaves the 4 px spacing base untouched (S11)', () => {
    expect(css).not.toContain('--spacing');
  });

  describe('drshya.css', () => {
    it('makes no third-party requests: no http(s) URL and no @import url(', () => {
      expect(drshyaCss).not.toMatch(/https?:/iu);
      expect(drshyaCss).not.toMatch(/@import\s+url\(/iu);
    });

    it('imports the Fontsource width-axis builds', () => {
      expect(drshyaCss).toContain("@import '@fontsource-variable/archivo/wdth.css';");
      expect(drshyaCss).toContain("@import '@fontsource-variable/archivo/wdth-italic.css';");
      expect(drshyaCss).toContain("@import '@fontsource-variable/martian-mono/wdth.css';");
    });

    it('defines the five voice utilities', () => {
      for (const voice of [
        'type-label',
        'type-display',
        'type-body',
        'type-agent',
        'type-engine',
      ]) {
        expect(drshyaCss).toContain(`@utility ${voice} {`);
      }
      expect(drshyaCss).toMatch(/@utility type-engine \{[^}]*font-stretch: 87\.5%;/u);
      expect(drshyaCss).toMatch(/@utility type-label \{[^}]*text-transform: uppercase;/u);
      expect(drshyaCss).toMatch(/@utility type-agent \{[^}]*font-style: italic;/u);
    });

    it('stops loops and view transitions under reduced motion', () => {
      const reduced = drshyaCss.slice(drshyaCss.indexOf('@media (prefers-reduced-motion: reduce)'));

      expect(reduced).toContain('animation-iteration-count: 1 !important;');
      expect(reduced).toContain('--duration-slow: 0ms;');
      expect(reduced).toContain('::view-transition-group(*)');
    });
  });
});
