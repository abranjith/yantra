// @no-llm
/**
 * BrowserViewport (FEAT-069 TASK-010): each state's message, accessible name
 * and icon; the canvas handed to `draw`; text-only page data; axe.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LIVE_VIEW_ENTRIES } from '../../src/gallery/live-view-entries.js';
import {
  BROWSER_VIEWPORT_MESSAGES,
  BROWSER_VIEWPORT_UNAVAILABLE,
  BrowserViewport,
  browserViewportMessage,
  type BrowserViewportState,
} from '../../src/instruments/BrowserViewport.js';
import { expectNoAxeViolations } from '../support/axe.js';

const COVERED: readonly Exclude<BrowserViewportState, 'live' | 'unavailable'>[] = [
  'connecting',
  'protected',
  'headed',
  'no_page',
  'reconnecting',
];

describe('BrowserViewport', () => {
  it('names the live canvas after the host and shows no message', () => {
    render(<BrowserViewport state="live" page={{ host: 'shop.example', title: 'Checkout' }} />);
    const canvas = screen.getByRole('img', { name: 'Live view of shop.example' });
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas.className).not.toContain('invisible');
    expect(document.querySelector('[data-part="viewport-message"]')).toBeNull();
  });

  it('falls back to a generic name while live without a host', () => {
    render(<BrowserViewport state="live" page={null} />);
    expect(screen.getByRole('img', { name: 'Live view of the task page' })).toBeDefined();
  });

  it.each(COVERED.map((state) => [state] as const))(
    'covers the canvas in %s with its message, icon and accessible name',
    (state) => {
      render(<BrowserViewport state={state} page={{ host: 'shop.example', title: 'T' }} />);
      const message = BROWSER_VIEWPORT_MESSAGES[state];
      const canvas = screen.getByRole('img', { name: message });
      expect(canvas.className).toContain('invisible');
      const overlay = document.querySelector('[data-part="viewport-message"]')!;
      expect(overlay.textContent).toBe(message);
      expect(overlay.querySelector('svg')).not.toBeNull();
    },
  );

  it('says "Protected screen — hidden" and never the host while protected', () => {
    render(<BrowserViewport state="protected" page={{ host: 'bank.example', title: 'Login' }} />);
    expect(document.body.textContent).toContain('Protected screen — hidden');
    expect(document.body.textContent).not.toContain('bank.example');
    expect(screen.getByRole('img').getAttribute('aria-label')).not.toContain('bank.example');
  });

  it.each(Object.entries(BROWSER_VIEWPORT_UNAVAILABLE))(
    'explains unavailable/%s',
    (reason, message) => {
      render(
        <BrowserViewport
          state="unavailable"
          reason={reason as keyof typeof BROWSER_VIEWPORT_UNAVAILABLE}
        />,
      );
      expect(screen.getByRole('img', { name: message })).toBeDefined();
    },
  );

  it('names a different Yantra version for an incompatible worker (D17)', () => {
    expect(browserViewportMessage('unavailable', 'incompatible_worker')).toMatch(
      /different Yantra version/u,
    );
    expect(browserViewportMessage('live')).toBeNull();
  });

  it('hands the canvas to draw, and null when it unmounts', () => {
    const draw = vi.fn();
    const { unmount } = render(<BrowserViewport state="live" draw={draw} />);
    expect(draw.mock.calls.at(-1)?.[0]).toBeInstanceOf(HTMLCanvasElement);
    unmount();
    expect(draw.mock.calls.at(-1)?.[0]).toBeNull();
  });

  it('marks its state for styling and tests', () => {
    render(<BrowserViewport state="headed" />);
    expect(
      document.querySelector('[data-instrument="browser-viewport"]')?.getAttribute('data-state'),
    ).toBe('headed');
  });

  it('has no axe violations in any state', async () => {
    const { container } = render(<>{LIVE_VIEW_ENTRIES[0]!.render()}</>);
    await expectNoAxeViolations(container);
  });
});
