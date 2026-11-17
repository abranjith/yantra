// @no-llm
/**
 * useBudgetMonitor (FEAT-069 TASK-011): switches the cockpit to Solid as a
 * runtime override, never touching the preference.
 */

import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CockpitLayout } from '../../src/features/cockpit/CockpitLayout.js';
import { useBudgetMonitor, type UseBudgetMonitor } from '../../src/live-view/use-budget-monitor.js';

let latest: UseBudgetMonitor | null = null;

function Probe(): ReactNode {
  latest = useBudgetMonitor();
  return (
    <CockpitLayout
      {...(latest.surfaces === undefined ? {} : { surfaces: latest.surfaces })}
      topBar={null}
      understood={null}
      engine={null}
      command={null}
    />
  );
}

/** Ten frames offered and none drawn per second, for `seconds`. */
function starve(seconds: number): void {
  for (let second = 0; second < seconds; second += 1) {
    for (let frame = 0; frame < 10; frame += 1) {
      act(() => {
        latest!.onSample({ kind: 'offered', busyMs: 0 });
        vi.advanceTimersByTime(100);
      });
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  delete document.documentElement.dataset.surfaces;
  latest = null;
});

describe('useBudgetMonitor', () => {
  it('switches the cockpit subtree to Solid and leaves the preference alone', () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
    });
    document.documentElement.dataset.surfaces = 'glass';
    render(<Probe />);
    const cockpit = document.querySelector('[data-part="cockpit"]')!;
    expect(cockpit.getAttribute('data-surfaces')).toBeNull();
    starve(11);
    expect(latest!.surfaces).toBe('solid');
    expect(cockpit.getAttribute('data-surfaces')).toBe('solid');
    expect(document.documentElement.dataset.surfaces).toBe('glass');
    // It stays switched for the rest of the run view.
    starve(11);
    expect(latest!.surfaces).toBe('solid');
  });

  it('never switches when the preference is already Solid', () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'],
    });
    document.documentElement.dataset.surfaces = 'solid';
    render(<Probe />);
    starve(11);
    expect(latest!.surfaces).toBeUndefined();
  });
});
