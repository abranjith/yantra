// @no-llm
/**
 * The live view's text alternative and its announcements (FEAT-069 TASK-010).
 */

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CockpitAnnouncer } from '../../src/features/cockpit/CockpitAnnouncer.js';
import type { AnnounceClock, AnnounceView } from '../../src/features/live/announcer.js';
import {
  LiveViewTextAlternative,
  RUN_TIMELINE_ANCHOR,
  liveViewAnnouncement,
} from '../../src/live-view/live-view-text-alternative.js';
import { expectNoAxeViolations } from '../support/axe.js';

describe('LiveViewTextAlternative', () => {
  it('shows host and title as text, with a link to the RunTimeline', () => {
    render(
      <LiveViewTextAlternative
        snapshot={{ state: 'live', reason: 'none', page: { host: 'shop.example', title: 'Cart' } }}
      />,
    );
    expect(screen.getByText('Live view: live')).toBeDefined();
    expect(document.querySelector('[data-part="live-view-host"]')?.textContent).toBe(
      'shop.example',
    );
    expect(document.querySelector('[data-part="live-view-title"]')?.textContent).toBe('Cart');
    expect(
      screen
        .getByRole('link', { name: 'What the run is doing, step by step' })
        .getAttribute('href'),
    ).toBe(RUN_TIMELINE_ANCHOR);
  });

  it('renders a title containing markup literally, never as HTML', () => {
    const title = '<img src=x onerror="alert(1)"><b>bold</b>';
    render(
      <LiveViewTextAlternative
        snapshot={{ state: 'live', reason: 'none', page: { host: 'evil.example', title } }}
      />,
    );
    const cell = document.querySelector('[data-part="live-view-title"]')!;
    expect(cell.textContent).toBe(title);
    expect(cell.querySelector('img')).toBeNull();
    expect(cell.querySelector('b')).toBeNull();
  });

  it.each([
    ['headed', 'Running in a visible window'],
    ['no_page', 'there is no live page to show'],
    ['protected', 'Protected screen — hidden'],
  ] as const)('explains %s when there is no page to name', (state, text) => {
    render(<LiveViewTextAlternative snapshot={{ state, reason: 'none', page: null }} />);
    expect(document.body.textContent).toContain(text);
    expect(screen.getByRole('link')).toBeDefined();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <LiveViewTextAlternative
        snapshot={{ state: 'live', reason: 'none', page: { host: 'a.example', title: 'A' } }}
      />,
    );
    await expectNoAxeViolations(container);
  });
});

describe('liveViewAnnouncement', () => {
  it('announces protected, back to live, headed and unavailable', () => {
    expect(liveViewAnnouncement('live', 'protected')).toMatch(/hidden/u);
    expect(liveViewAnnouncement('protected', 'live')).toMatch(/showing again/u);
    expect(liveViewAnnouncement('reconnecting', 'live')).toMatch(/showing again/u);
    expect(liveViewAnnouncement('connecting', 'headed')).toMatch(/visible browser window/u);
    expect(liveViewAnnouncement('live', 'unavailable')).toMatch(/unavailable/u);
  });

  it('stays quiet for the first frame, repeats, and the in-between states', () => {
    expect(liveViewAnnouncement(null, 'live')).toBeNull();
    expect(liveViewAnnouncement('connecting', 'live')).toBeNull();
    expect(liveViewAnnouncement('live', 'live')).toBeNull();
    expect(liveViewAnnouncement('live', 'connecting')).toBeNull();
    expect(liveViewAnnouncement('live', 'no_page')).toBeNull();
    expect(liveViewAnnouncement('live', 'reconnecting')).toBeNull();
  });
});

describe('CockpitAnnouncer live view', () => {
  const VIEW: AnnounceView = {
    kind: 'running',
    contract: null,
    interventions: [],
    met: 0,
    total: 0,
    outcome: null,
  } as unknown as AnnounceView;

  /** A clock whose scheduled callbacks run only when flushed. */
  function manualClock(): AnnounceClock & { flush(): void } {
    let tasks: (() => void)[] = [];
    return {
      now: () => 0,
      schedule: (callback: () => void) => {
        tasks.push(callback);
        return () => {
          tasks = tasks.filter((task) => task !== callback);
        };
      },
      flush: () => {
        const due = tasks;
        tasks = [];
        for (const task of due) task();
      },
    };
  }

  it('speaks each live-view change once, and nothing for frames', () => {
    const clock = manualClock();
    const spoken: string[] = [];
    const { rerender } = render(
      <CockpitAnnouncer view={VIEW} clock={clock} onSpoken={(text) => spoken.push(text)} />,
    );
    const say = (liveView: { id: number; text: string } | null) => {
      rerender(
        <CockpitAnnouncer
          view={VIEW}
          clock={clock}
          liveView={liveView}
          onSpoken={(text) => spoken.push(text)}
        />,
      );
      act(() => {
        clock.flush();
      });
    };
    say({ id: 1, text: 'Live view hidden: a protected screen is showing.' });
    // Re-rendering with the same announcement (a new frame drawn) says nothing.
    say({ id: 1, text: 'Live view hidden: a protected screen is showing.' });
    say({ id: 2, text: 'Live view showing again.' });
    say({ id: 3, text: 'Live view hidden: a protected screen is showing.' });
    expect(spoken.filter((text) => text.startsWith('Live view'))).toEqual([
      'Live view hidden: a protected screen is showing.',
      'Live view showing again.',
      'Live view hidden: a protected screen is showing.',
    ]);
  });
});
