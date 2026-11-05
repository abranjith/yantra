import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareStrictCsp, REACT_ARIA_PRESSABLE_STYLE_ID } from '../src/csp.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** react-aria's own usePress build, resolved through react-aria-components. */
function reactAriaUsePressSource(): string {
  const requireFromUi = createRequire(join(packageRoot, 'package.json'));
  const racEntry = requireFromUi.resolve('react-aria-components');
  const requireFromRac = createRequire(racEntry);
  const ariaRoot = dirname(requireFromRac.resolve('react-aria/package.json'));
  const dir = join(ariaRoot, 'dist/private/interactions');
  const file = readdirSync(dir).find((name) => name === 'usePress.mjs');
  if (file === undefined) {
    throw new Error(`usePress.mjs not found under ${dir}; React Aria's layout changed`);
  }
  return readFileSync(join(dir, file), 'utf8');
}

describe('@no-llm Drshya strict-CSP preparation', () => {
  afterEach(() => {
    document.getElementById(REACT_ARIA_PRESSABLE_STYLE_ID)?.remove();
  });

  it('places a non-style marker with React Aria’s pressable style id', () => {
    prepareStrictCsp(document);

    const marker = document.getElementById(REACT_ARIA_PRESSABLE_STYLE_ID);
    expect(marker?.tagName).toBe('META');
    expect(marker?.parentElement).toBe(document.head);
    expect(document.head.querySelector('style')).toBeNull();
  });

  it('is idempotent', () => {
    prepareStrictCsp(document);
    prepareStrictCsp(document);

    expect(document.querySelectorAll(`#${REACT_ARIA_PRESSABLE_STYLE_ID}`)).toHaveLength(1);
  });

  it('matches the id the pinned React Aria checks before injecting its style', () => {
    const source = reactAriaUsePressSource();

    expect(source).toContain(`'${REACT_ARIA_PRESSABLE_STYLE_ID}'`);
    expect(source).toContain('getElementById(');
  });

  it('ships the pressable rule React Aria would have injected', () => {
    const css = readFileSync(join(packageRoot, 'src/styles/drshya.css'), 'utf8');
    const source = reactAriaUsePressSource();

    expect(source).toContain('touch-action: pan-x pan-y pinch-zoom;');
    expect(css).toMatch(
      /\[data-react-aria-pressable\] \{\s*touch-action: pan-x pan-y pinch-zoom;\s*\}/u,
    );
    expect(source).toContain("'data-react-aria-pressable'");
  });
});
