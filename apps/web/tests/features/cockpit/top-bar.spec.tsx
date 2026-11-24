import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { BinduProvider, BinduStore } from '../../../src/app/shell/bindu-store.js';
import { TopBar } from '../../../src/app/shell/TopBar.js';
import { cockpitBindu } from '../../../src/features/cockpit/bindu-state.js';
import { CockpitTopBar } from '../../../src/features/cockpit/CockpitTopBar.js';
import {
  initialCockpitState,
  reduceRunEvents,
  type CockpitState,
} from '../../../src/features/live/cockpit-state.js';
import {
  TickClockProvider,
  elapsedMs,
  formatElapsed,
  type TickClock,
} from '../../../src/features/live/tick-clock.js';
import { ev, numbered } from '../../support/run-events.js';

/** A clock the test moves forward one second at a time. */
class SteppedClock implements TickClock {
  private listeners = new Set<() => void>();

  public constructor(private time: number) {}

  public now(): number {
    return this.time;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public get listening(): number {
    return this.listeners.size;
  }

  public tick(seconds = 1): void {
    this.time += seconds * 1_000;
    act(() => {
      for (const listener of [...this.listeners]) listener();
    });
  }
}

const START = Date.parse('2026-11-14T10:00:00.000Z');

function stateOf(events: readonly unknown[]): CockpitState {
  return reduceRunEvents(initialCockpitState('run-1', 'research'), numbered(events)).state;
}

function Harness({
  clock,
  store,
  children,
}: {
  readonly clock: TickClock;
  readonly store: BinduStore;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TickClockProvider value={clock}>
      <BinduProvider store={store}>
        {/* No router here: the bar shows the wordmark and the Bindu only. */}
        <TopBar live={false} />
        {children}
      </BinduProvider>
    </TickClockProvider>
  );
}

function elapsedText(): string {
  return document.querySelector('[data-part="elapsed"]')?.textContent ?? '';
}

describe('@no-llm cockpit top bar', () => {
  it('shows the mode word and the goal from goal_echo', () => {
    render(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar state={stateOf([ev('goal_echo')])} />
      </Harness>,
    );

    expect(document.querySelector('[data-part="mode"]')?.textContent).toBe('research');
    expect(screen.getByText('find flights')).toBeDefined();
  });

  it('prefers the mode the route knows and shows a dash when nobody does', () => {
    const { rerender } = render(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar state={stateOf([])} mode="do" />
      </Harness>,
    );
    expect(document.querySelector('[data-part="mode"]')?.textContent).toBe('do');

    rerender(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar state={reduceRunEvents(initialCockpitState('run-1'), []).state} />
      </Harness>,
    );
    expect(document.querySelector('[data-part="mode"]')?.textContent).toBe('—');
    expect(screen.getByText('Waiting for the run to start…')).toBeDefined();
  });

  it('advances elapsed time once per second on a stepped clock', () => {
    const clock = new SteppedClock(START + 5_000);
    render(
      <Harness clock={clock} store={new BinduStore()}>
        <CockpitTopBar state={stateOf([ev('goal_echo', { at: '2026-11-14T10:00:00.000Z' })])} />
      </Harness>,
    );

    expect(elapsedText()).toBe('Elapsed5s');
    clock.tick();
    expect(elapsedText()).toBe('Elapsed6s');
    clock.tick(60);
    expect(elapsedText()).toBe('Elapsed1m 06s');
  });

  it('freezes elapsed time at the outcome and stops listening to the clock', () => {
    const clock = new SteppedClock(START + 90_000);
    render(
      <Harness clock={clock} store={new BinduStore()}>
        <CockpitTopBar
          state={stateOf([
            ev('goal_echo', { at: '2026-11-14T10:00:00.000Z' }),
            ev('run_outcome', { at: '2026-11-14T10:00:42.000Z' }),
          ])}
        />
      </Harness>,
    );

    clock.tick(10);

    expect(elapsedText()).toBe('Elapsed42s');
    expect(clock.listening).toBe(0);
  });

  it('shows a dash before the run has started', () => {
    render(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar state={stateOf([])} />
      </Harness>,
    );

    expect(elapsedText()).toBe('Elapsed—');
  });

  it('renders one gauge per budget, and none without a snapshot', () => {
    const { rerender } = render(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar state={stateOf([ev('goal_echo')])} />
      </Harness>,
    );
    expect(document.querySelector('[data-instrument="budgets"]')).toBeNull();

    rerender(
      <Harness clock={new SteppedClock(START)} store={new BinduStore()}>
        <CockpitTopBar
          state={stateOf([
            ev('budget_snapshot', {
              dimensions: [
                { name: 'hops', used: 2, limit: 2, unit: 'count' },
                { name: 'elapsed', used: 1_000, limit: 180_000, unit: 'ms' },
              ],
            }),
          ])}
        />
      </Harness>,
    );
    expect(screen.getAllByRole('meter')).toHaveLength(2);
    expect(screen.getByText('exhausted')).toBeDefined();
  });

  it('drives the shell Bindu while mounted and hands it back to idle', () => {
    const store = new BinduStore();
    const { rerender, unmount } = render(
      <Harness clock={new SteppedClock(START)} store={store}>
        <CockpitTopBar state={stateOf([ev('goal_echo'), ev('tool_started')])} />
      </Harness>,
    );
    expect(screen.getByRole('img', { name: 'Engine: acting' })).toBeDefined();

    rerender(
      <Harness clock={new SteppedClock(START)} store={store}>
        <CockpitTopBar state={stateOf([ev('goal_echo'), ev('run_outcome')])} />
      </Harness>,
    );
    expect(screen.getByRole('img', { name: 'Engine: fulfilled' })).toBeDefined();

    unmount();
    expect(store.getSnapshot()).toEqual({ state: 'idle' });
  });
});

describe('@no-llm cockpit Bindu mapping', () => {
  it('names each run state', () => {
    expect(cockpitBindu(stateOf([]))).toEqual({ state: 'live', label: 'Engine: starting' });
    expect(cockpitBindu(stateOf([ev('goal_echo')]))).toEqual({ state: 'thinking' });
    expect(cockpitBindu(stateOf([ev('tool_started')]))).toEqual({ state: 'acting' });
    expect(cockpitBindu(stateOf([ev('search_completed')]))).toEqual({ state: 'acting' });
    expect(cockpitBindu(stateOf([ev('recovery')]))).toEqual({
      state: 'thinking',
      label: 'Engine: stalled',
    });
    expect(cockpitBindu(stateOf([ev('intervention_raised')]))).toEqual({ state: 'needs_you' });
  });

  it('needs you when the start needs a decision', () => {
    expect(cockpitBindu(stateOf([]), 'needs_review')).toEqual({ state: 'needs_you' });
    expect(cockpitBindu(stateOf([]), 'start_unknown')).toEqual({ state: 'needs_you' });
    expect(cockpitBindu(stateOf([]), 'queued')).toEqual({
      state: 'live',
      label: 'Engine: starting',
    });
  });

  it('says each outcome in its word', () => {
    expect(cockpitBindu(stateOf([ev('run_outcome')]))).toEqual({ state: 'fulfilled' });
    expect(cockpitBindu(stateOf([ev('run_outcome', { task_outcome: 'partial' })]))).toEqual({
      state: 'idle',
      label: 'Engine: partial',
    });
    expect(
      cockpitBindu(
        stateOf([ev('run_outcome', { task_outcome: 'failed', termination_reason: 'owner_lost' })]),
      ),
    ).toEqual({ state: 'idle', label: 'Engine: interrupted, failed' });
  });
});

describe('@no-llm elapsed time', () => {
  it('measures to now while live and to the end once ended', () => {
    expect(elapsedMs('2026-11-14T10:00:00.000Z', null, START + 7_500)).toBe(7_500);
    expect(elapsedMs('2026-11-14T10:00:00.000Z', '2026-11-14T10:00:03.000Z', START + 99_000)).toBe(
      3_000,
    );
    expect(elapsedMs('not a date', null, START)).toBe(0);
    expect(elapsedMs('2026-11-14T10:00:10.000Z', null, START)).toBe(0);
  });

  it('formats seconds, minutes and hours', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(59_999)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m 05s');
  });
});
