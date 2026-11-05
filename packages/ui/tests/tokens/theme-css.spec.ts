import { describe, expect, it } from 'vitest';

import { emitThemeCss } from '../../src/tokens/emit.js';
import { PRIMITIVES } from '../../src/tokens/palette.js';
import { SEMANTIC_COLOR_NAMES } from '../../src/tokens/semantic.js';

import { blockBody, declarations, propertyNames } from './css-blocks.js';

const css = emitThemeCss();

const OS_DARK = ':root:not([data-theme="light"])';
const EXPLICIT_DARK = '[data-theme="dark"]';
const EXPLICIT_LIGHT = '[data-theme="light"]';

const THEME_BLOCKS = {
  '@theme': blockBody(css, '@theme'),
  'OS dark': blockBody(blockBody(css, '@media (prefers-color-scheme: dark)'), `  ${OS_DARK}`),
  'explicit dark': blockBody(css, EXPLICIT_DARK),
  'explicit light': blockBody(css, EXPLICIT_LIGHT),
} as const;

describe('@no-llm Drshya theme CSS', () => {
  it('declares primitives as plain --drshya-* properties on :root, never in @theme', () => {
    const root = blockBody(css, ':root');
    const theme = THEME_BLOCKS['@theme'];

    for (const primitive of PRIMITIVES) {
      expect(propertyNames(root)).toContain(`--drshya-${primitive.name}`);
    }
    expect(theme).not.toMatch(/--color-(fog|ion|jade|amber|crimson|rani)\b/u);
    expect(propertyNames(theme).filter((name) => !name.startsWith('--color-'))).toEqual([
      '--shadow-glass',
    ]);
  });

  it('clears the default color namespace so no Tailwind palette utility exists', () => {
    expect(declarations(THEME_BLOCKS['@theme'])[0]).toBe('--color-*: initial;');
  });

  it('declares every semantic color exactly once per theme block', () => {
    const expected = SEMANTIC_COLOR_NAMES.map((color) => `--color-${color}`);
    const actual = Object.fromEntries(
      Object.entries(THEME_BLOCKS).map(([label, body]) => [
        label,
        propertyNames(body).filter((name) => name.startsWith('--color-') && name !== '--color-*'),
      ]),
    );

    expect(actual).toEqual(
      Object.fromEntries(Object.keys(THEME_BLOCKS).map((label) => [label, expected])),
    );
  });

  it('gives both dark selectors identical declarations', () => {
    expect(declarations(THEME_BLOCKS['OS dark'])).toEqual(
      declarations(THEME_BLOCKS['explicit dark']),
    );
  });

  it('maps semantic colors to primitives through var(), never literal values', () => {
    for (const body of Object.values(THEME_BLOCKS)) {
      for (const line of declarations(body).filter((entry) => entry.startsWith('--color-'))) {
        if (line === '--color-*: initial;') {
          continue;
        }
        expect(line).toMatch(/^--color-[a-z0-9-]+: var\(--drshya-[a-z0-9-]+\);$/u);
      }
    }
  });

  it('sets color-scheme alongside each theme', () => {
    expect(declarations(blockBody(css, ':root'))).toContain('color-scheme: light;');
    expect(declarations(THEME_BLOCKS['OS dark'])).toContain('color-scheme: dark;');
    expect(declarations(THEME_BLOCKS['explicit dark'])).toContain('color-scheme: dark;');
    expect(declarations(THEME_BLOCKS['explicit light'])).toContain('color-scheme: light;');
  });

  it('re-declares only the theme-dependent primitives in theme blocks', () => {
    const themed = PRIMITIVES.filter(
      (primitive) => JSON.stringify(primitive.light) !== JSON.stringify(primitive.dark),
    ).map((primitive) => `--drshya-${primitive.name}`);
    const dark = propertyNames(THEME_BLOCKS['explicit dark']).filter((name) =>
      name.startsWith('--drshya-'),
    );

    expect(dark).toEqual(themed);
    expect(dark.some((name) => name.startsWith('--drshya-fog'))).toBe(false);
    expect(declarations(THEME_BLOCKS['explicit dark'])).toContain(
      '--drshya-ion-fill: oklch(0.8 0.14 218);',
    );
    expect(declarations(THEME_BLOCKS['explicit light'])).toContain(
      '--drshya-ion-fill: oklch(0.54 0.097 218);',
    );
  });

  it('lets the OS dark theme yield to an explicit light pin', () => {
    expect(css).toContain(`@media (prefers-color-scheme: dark) {\n  ${OS_DARK} {`);
    expect(css.indexOf(EXPLICIT_LIGHT + ' {')).toBeGreaterThan(css.indexOf(EXPLICIT_DARK + ' {'));
  });

  it('is deterministic', () => {
    expect(emitThemeCss()).toBe(css);
  });

  it('ends with exactly one newline and uses LF only', () => {
    expect(css.endsWith('}\n')).toBe(true);
    expect(css).not.toContain('\r');
  });
});
