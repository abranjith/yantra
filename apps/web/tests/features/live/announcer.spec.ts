import { describe, expect, it } from 'vitest';

import { announceView } from '../../../src/features/cockpit/CockpitAnnouncer.js';
import {
  ANNOUNCE_INTERVAL_MS,
  announcementsFor,
  createAnnouncementQueue,
  type AnnounceClock,
  type AnnounceView,
  type Announcement,
} from '../../../src/features/live/announcer.js';
import {
  initialCockpitState,
  reduceRunEvent,
  type CockpitState,
} from '../../../src/features/live/cockpit-state.js';
import { deriveDisplayedState } from '../../../src/features/live/displayed-state.js';
import { recordedResearch } from '../../support/recorded-runs.js';
import { ev, numbered } from '../../support/run-events.js';

/** A clock the test moves by hand; due timers fire as time passes. */
class SteppedClock implements AnnounceClock {
  public time = 0;
  private timers: { at: number; callback: () => void }[] = [];

  public now(): number {
    return this.time;
  }

  public schedule(callback: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, callback };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((item) => item !== timer);
    };
  }

  public advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = end;
  }
}

function view(overrides: Partial<AnnounceView> = {}): AnnounceView {
  return {
    kind: 'running',
    contract: null,
    interventions: [],
    met: 0,
    total: 0,
    outcome: null,
    ...overrides,
  };
}

function texts(items: readonly Announcement[]): string[] {
  return items.map((item) => item.text);
}

/** Every announcement a run's events produce, one event at a time. */
function announcementsOf(events: readonly unknown[]): string[] {
  let state: CockpitState = initialCockpitState('run-1', 'do');
  let previous: AnnounceView | null = null;
  const all: string[] = [];
  for (const item of numbered(events)) {
    state = reduceRunEvent(state, item).state;
    const kind = deriveDisplayedState({
      invocation: null,
      connection: { status: 'connected' },
      channel: { state: 'live' },
      cockpit: state,
      stopping: false,
    }).kind;
    const next = announceView(state, kind);
    all.push(...texts(announcementsFor(previous, next)));
    previous = next;
  }
  return all;
}

describe('@no-llm announcements: what is said', () => {
  it('says nothing about 500 tool calls beyond the run starting', () => {
    const events: unknown[] = [ev('goal_echo')];
    for (let index = 0; index < 250; index += 1)
      events.push(ev('tool_started'), ev('tool_finished'));

    const said = announcementsOf(events);

    expect(said).toEqual(['Run status: running.']);
    expect(said.join(' ')).not.toMatch(/browser_fill|tool/u);
  });

  it('never announces phases or budget ticks', () => {
    const said = announcementsOf([
      ev('goal_echo'),
      ev('search_completed'),
      ev('source_fetched'),
      ev('budget_snapshot'),
      ev('extract_completed'),
      ev('synthesize_started'),
    ]);

    expect(said).toEqual(['Run status: running.']);
  });

  it('announces the contract, its revisions, met requirements, waits and the outcome', () => {
    const said = announcementsOf([
      ev('goal_echo'),
      ev('contract_declared'),
      ev('progress'),
      ev('contract_declared', { revision: 2, summary: 'Fill the form only' }),
      ev('intervention_raised'),
      ev('intervention_resolved'),
      ev('progress', {
        items: [
          { id: 'fill', kind: 'fill', label: 'Fill', state: 'met', done: 5, total: 5 },
          {
            id: 'deliverable',
            kind: 'deliverable',
            label: 'Report',
            state: 'pending',
            done: null,
            total: null,
          },
        ],
      }),
      ev('run_outcome'),
    ]);

    expect(said).toEqual([
      'Run status: running.',
      'Understood: Fill the contact form and take a screenshot',
      'Contract revised: Fill the form only',
      'Waiting for you: Submit the order form.',
      'Your answer was received.',
      'Run status: running.',
      '1 of 2 requirements met.',
      'Run finished: fulfilled.',
    ]);
  });

  it('announces the states the plan lists, and the recovery back to running', () => {
    expect(texts(announcementsFor(view(), view({ kind: 'disconnected' })))).toEqual([
      'Run status: disconnected.',
    ]);
    expect(texts(announcementsFor(view({ kind: 'disconnected' }), view()))).toEqual([
      'Run status: running.',
    ]);
    expect(texts(announcementsFor(view(), view({ kind: 'live_view_unavailable' })))).toEqual([
      'Run status: live view unavailable.',
    ]);
    expect(texts(announcementsFor(null, view({ kind: 'queued' })))).toEqual([
      'Run status: queued.',
    ]);
  });

  it('does not announce stopping, or a state change after the outcome', () => {
    expect(announcementsFor(view(), view({ kind: 'stopping' }))).toEqual([]);
    const ended = view({ kind: 'finished', outcome: 'aborted' });
    expect(texts(announcementsFor(view({ kind: 'stopping' }), ended))).toEqual([
      'Run finished: aborted.',
    ]);
    expect(announcementsFor(ended, { ...ended, kind: 'disconnected' })).toEqual([]);
  });

  it('says the interrupted outcome in words', () => {
    let state = initialCockpitState('run-1');
    state = reduceRunEvent(state, {
      seq: 1,
      event: ev('run_outcome', { task_outcome: 'partial', termination_reason: 'owner_lost' }),
    }).state;

    expect(texts(announcementsFor(null, announceView(state, 'finished')))).toEqual([
      'Run finished: interrupted · partial.',
    ]);
  });

  it('keeps an outcome and a wait for you, and nothing else, by default', () => {
    const items = announcementsFor(
      view(),
      view({ outcome: 'fulfilled', interventions: [{ id: 'a', summary: 'Pay' }] }),
    );

    expect(items.filter((item) => item.keep).map((item) => item.category)).toEqual([
      'outcome',
      'intervention',
    ]);
  });
});

describe('@no-llm announcements: pacing', () => {
  function queue(clock: SteppedClock) {
    const spoken: { at: number; text: string }[] = [];
    const announcer = createAnnouncementQueue(
      (text) => spoken.push({ at: clock.now(), text }),
      clock,
    );
    return { spoken, announcer };
  }

  it('speaks the first announcement at once', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);

    announcer.push([{ category: 'state', text: 'Run status: running.', keep: false }]);

    expect(spoken).toEqual([{ at: 0, text: 'Run status: running.' }]);
  });

  it('collapses a window to the newest of each category', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);
    announcer.push([{ category: 'state', text: 'Run status: running.', keep: false }]);

    clock.advance(100);
    announcer.push([{ category: 'requirements', text: '1 of 5 requirements met.', keep: false }]);
    clock.advance(100);
    announcer.push([{ category: 'requirements', text: '2 of 5 requirements met.', keep: false }]);
    clock.advance(100);
    announcer.push([{ category: 'state', text: 'Run status: engine stalled.', keep: false }]);
    clock.advance(ANNOUNCE_INTERVAL_MS);

    expect(spoken).toEqual([
      { at: 0, text: 'Run status: running.' },
      { at: ANNOUNCE_INTERVAL_MS, text: 'Run status: engine stalled. 2 of 5 requirements met.' },
    ]);
  });

  it('never drops an outcome or a wait inside a window, and says them first', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);
    announcer.push([{ category: 'state', text: 'Run status: running.', keep: false }]);

    clock.advance(500);
    announcer.push([{ category: 'intervention', text: 'Waiting for you: Pay.', keep: true }]);
    announcer.push([{ category: 'intervention', text: 'Waiting for you: Ship.', keep: true }]);
    announcer.push([{ category: 'outcome', text: 'Run finished: fulfilled.', keep: true }]);
    clock.advance(ANNOUNCE_INTERVAL_MS);

    expect(spoken.at(-1)?.text).toBe(
      'Run finished: fulfilled. Waiting for you: Pay. Waiting for you: Ship.',
    );
  });

  it('speaks at most once per 2 s through a fast research run', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);
    const { records } = recordedResearch();
    let state = initialCockpitState(records[0]!.run_id, 'research');
    let previous: AnnounceView | null = null;
    // A fast run: one event every 20 ms, plus an extra contract and waits.
    const extra = [
      ev('contract_declared'),
      ev('intervention_raised'),
      ev('intervention_resolved'),
      ev('contract_declared', { revision: 2 }),
    ];
    // The extra events land before the run's outcome, which stays last.
    const events = [
      ...records.slice(0, -1).map((record) => record.event),
      ...extra,
      records.at(-1)!.event,
    ];
    for (const item of numbered(events)) {
      state = reduceRunEvent(state, item).state;
      const kind = deriveDisplayedState({
        invocation: null,
        connection: { status: 'connected' },
        channel: { state: 'live' },
        cockpit: state,
        stopping: false,
      }).kind;
      const next = announceView(state, kind);
      announcer.push(announcementsFor(previous, next));
      previous = next;
      clock.advance(20);
    }
    clock.advance(10 * ANNOUNCE_INTERVAL_MS);

    const gaps = spoken.slice(1).map((item, index) => item.at - spoken[index]!.at);
    expect(gaps.every((gap) => gap >= ANNOUNCE_INTERVAL_MS)).toBe(true);
    expect(spoken.some((item) => item.text.includes('Run finished: fulfilled.'))).toBe(true);
    expect(spoken.map((item) => item.text).join(' ')).not.toMatch(/search|fetch|extract/u);
  });

  it('cancels its timer when disposed', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);
    announcer.push([{ category: 'state', text: 'a', keep: false }]);
    announcer.push([{ category: 'state', text: 'b', keep: false }]);

    announcer.dispose();
    clock.advance(10 * ANNOUNCE_INTERVAL_MS);

    expect(spoken.map((item) => item.text)).toEqual(['a']);
  });

  it('ignores an empty push', () => {
    const clock = new SteppedClock();
    const { spoken, announcer } = queue(clock);

    announcer.push([]);

    expect(spoken).toEqual([]);
  });
});
