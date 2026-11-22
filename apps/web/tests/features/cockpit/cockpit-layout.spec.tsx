// @no-llm
/**
 * REV-003: the cockpit floats its panels over the live browser, which fills
 * the frame, and keeps the centre clear. Real-Chrome geometry (the canvas is
 * the topmost element at the centre) is asserted in
 * `e2e/app-live-view-window.spec.ts`; this pins the structure that produces it.
 */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CockpitLayout } from '../../../src/features/cockpit/CockpitLayout.js';

function renderLayout() {
  return render(
    <CockpitLayout
      topBar={<p>top</p>}
      status={<p>status</p>}
      understood={<p>understood</p>}
      engine={<p>engine</p>}
      command={<p>command</p>}
      backdrop={<canvas data-testid="view" />}
    />,
  );
}

describe('the cockpit frame (REV-003)', () => {
  it('fills the frame with the backdrop from lg up, hidden from assistive technology', () => {
    const { container } = renderLayout();
    const backdrop = container.querySelector('[data-slot="backdrop"]')!;
    expect(backdrop.getAttribute('aria-hidden')).toBe('true');
    expect(backdrop.className).toMatch(/\blg:absolute\b/u);
    expect(backdrop.className).toMatch(/\blg:inset-0\b/u);
    expect(backdrop.querySelector('[data-testid="view"]')).not.toBeNull();
  });

  it('gives the frame a fixed height from lg up, so panels cannot push the page away', () => {
    const { container } = renderLayout();
    const frame = container.querySelector('[data-part="cockpit"]')!;
    expect(frame.className).toMatch(/\blg:h-\[/u);
  });

  it('keeps a clear centre between the Understood and Engine rails', () => {
    const { container } = renderLayout();
    const middle = container.querySelector('[data-part="cockpit-middle"]')!;
    const children = [...middle.children].map(
      (child) => child.getAttribute('data-panel') ?? child.getAttribute('data-slot'),
    );
    expect(children).toEqual(['understood', 'viewport-window', 'engine']);
    const centre = middle.querySelector('[data-slot="viewport-window"]')!;
    expect(centre.childElementCount).toBe(0);
    expect(centre.getAttribute('aria-hidden')).toBe('true');
  });

  it('lets clicks through only where nothing is drawn: the panels stay interactive', () => {
    const { container } = renderLayout();
    const middle = container.querySelector('[data-part="cockpit-middle"]')!;
    expect(middle.className).toMatch(/\bpointer-events-none\b/u);
    for (const id of ['understood', 'engine']) {
      expect(container.querySelector(`[data-panel="${id}"]`)!.className).toMatch(
        /\bpointer-events-auto\b/u,
      );
    }
    expect(container.querySelector('[data-slot="viewport-window"]')!.className).toMatch(
      /\bpointer-events-none\b/u,
    );
  });

  it('lets each rail scroll its own content instead of growing over the page', () => {
    const { container } = renderLayout();
    for (const id of ['understood', 'engine', 'command']) {
      const plate = container.querySelector(`[data-panel="${id}"] > div`)!;
      expect(plate.className).toMatch(/\boverflow-y-auto\b/u);
    }
  });
});
