/**
 * axe-core in jsdom (FEAT-066). jsdom has no layout or CSS, so rules that need
 * rendering (color contrast) run in the real-Chrome e2e harness instead.
 */

import axe from 'axe-core';
import { expect } from 'vitest';

/** Runs axe on `root` under each theme and asserts no violations. */
export async function expectNoAxeViolations(
  root: Element,
  themes: readonly ('light' | 'dark')[] = ['light', 'dark'],
): Promise<void> {
  for (const theme of themes) {
    document.documentElement.dataset.theme = theme;
    const result = await axe.run(root, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(
      result.violations.map((violation) => ({
        theme,
        id: violation.id,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    ).toEqual([]);
  }
  delete document.documentElement.dataset.theme;
}
