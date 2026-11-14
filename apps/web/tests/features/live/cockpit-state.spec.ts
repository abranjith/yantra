import { describe, expect, it } from 'vitest';

import { logEntries } from '../../../src/features/live/bounded-log.js';
import {
  GOAL_MAX_CHARS,
  INSPECTOR_CAP,
  TIMELINE_CAP,
  engineState,
  goalFromEcho,
  initialCockpitState,
  modeOf,
  reduceRunEvent,
  reduceRunEvents,
  type CockpitState,
} from '../../../src/features/live/cockpit-state.js';
import { ev, numbered } from '../../support/run-events.js';

function replay(events: readonly unknown[], state = initialCockpitState('run-1')): CockpitState {
  const result = reduceRunEvents(state, numbered(events, state.lastSeq + 1));
  expect(result.gap).toBe(false);
  return result.state;
}

describe('@no-llm cockpit reducer: seq rule', () => {
  it('starts before seq 1 with nothing applied', () => {
    const state = initialCockpitState('run-1', 'research');

    expect(state.lastSeq).toBe(0);
    expect(state.mode).toBe('research');
    expect(engineState(state)).toBe('idle');
  });

  it('ignores a duplicate seq and returns the same state', () => {
    const once = replay([ev('goal_echo')]);

    const again = reduceRunEvent(once, {
      seq: 1,
      event: ev('goal_echo', { display: 'goal: "x"' }),
    });

    expect(again.gap).toBe(false);
    expect(again.state).toBe(once);
  });

  it('refuses an event past lastSeq + 1 as a gap without applying it', () => {
    const state = replay([ev('task_started')]);

    const result = reduceRunEvent(state, { seq: 3, event: ev('goal_echo') });

    expect(result.gap).toBe(true);
    expect(result.state).toBe(state);
  });

  it('stops a batch at the first gap and keeps what came before', () => {
    const result = reduceRunEvents(initialCockpitState('run-1'), [
      { seq: 1, event: ev('task_started') },
      { seq: 2, event: ev('goal_echo') },
      { seq: 4, event: ev('run_outcome') },
    ]);

    expect(result.gap).toBe(true);
    expect(result.state.lastSeq).toBe(2);
    expect(result.state.outcome).toBeNull();
  });

  it('ignores a non-integer seq', () => {
    const state = initialCockpitState('run-1');

    expect(reduceRunEvent(state, { seq: 1.5, event: ev('goal_echo') }).state).toBe(state);
    expect(reduceRunEvent(state, { seq: Number.NaN, event: ev('goal_echo') }).state).toBe(state);
  });

  it('gives the same state for a replay with duplicates as for a straight replay', () => {
    const events = [ev('goal_echo'), ev('tool_started'), ev('tool_finished'), ev('run_outcome')];
    const straight = replay(events);

    let state = initialCockpitState('run-1');
    for (const item of [...numbered(events.slice(0, 2)), ...numbered(events)]) {
      state = reduceRunEvent(state, item).state;
    }

    expect(state).toEqual(straight);
  });
});

describe('@no-llm cockpit reducer: fields', () => {
  it('takes the goal from goal_echo, without its prefix and quotes', () => {
    expect(replay([ev('goal_echo')]).goal).toBe('find flights');
  });

  it('strips control characters and caps the goal at 200 characters', () => {
    const long = `a\u0007b${'x'.repeat(400)}`;

    const goal = goalFromEcho(`goal: "${long}"`);

    expect(goal.startsWith('a b')).toBe(true);
    expect([...goal]).toHaveLength(GOAL_MAX_CHARS);
    expect(goal.endsWith('…')).toBe(true);
    expect(goalFromEcho('goal: [not shown: contains a secret]')).toBe(
      '[not shown: contains a secret]',
    );
  });

  it('records when the run started from its first start event', () => {
    const state = replay([
      ev('progress'),
      ev('goal_echo', { at: '2026-11-14T10:00:01.000Z' }),
      ev('task_started', { at: '2026-11-14T10:00:05.000Z' }),
    ]);

    expect(state.startedAt).toBe('2026-11-14T10:00:01.000Z');
    expect(state.firstSeq).toBe(1);
  });

  it('keeps the latest contract revision', () => {
    const state = replay([
      ev('contract_declared'),
      ev('contract_declared', { revision: 2, summary: 'Fill the form only' }),
    ]);

    expect(state.contract).toEqual({ revision: 2, summary: 'Fill the form only' });
  });

  it('replaces the requirements wholesale on every progress event', () => {
    const first = replay([ev('progress')]);
    const second = replay(
      [
        ev('progress', {
          items: [{ id: 'fill', kind: 'fill', label: 'Fill', state: 'met', done: 5, total: 5 }],
          summary: 'all fields filled',
        }),
      ],
      first,
    );

    expect(first.requirements).toHaveLength(2);
    expect(second.requirements).toEqual([
      { id: 'fill', kind: 'fill', label: 'Fill', state: 'met', done: 5, total: 5 },
    ]);
    expect(second.progressSummary).toBe('all fields filled');
  });

  it('lists each capability gap once', () => {
    const state = replay([ev('capability_gap'), ev('capability_gap')]);

    expect(state.capabilityGaps).toEqual([
      { item: 'artifact:screenshot:viewport', summary: 'Cannot deliver: viewport screenshot.' },
    ]);
  });

  it('keeps the latest budget snapshot', () => {
    const state = replay([
      ev('budget_snapshot'),
      ev('budget_snapshot', {
        dimensions: [{ name: 'hops', used: 1, limit: 3, unit: 'count' }],
      }),
    ]);

    expect(state.budgets?.dimensions).toEqual([{ name: 'hops', used: 1, limit: 3, unit: 'count' }]);
  });

  it('opens a pending intervention and removes it when resolved', () => {
    const raised = replay([ev('intervention_raised')]);
    const resolved = replay([ev('intervention_resolved')], raised);

    expect(raised.pendingInterventions).toEqual([
      {
        interventionId: '01JD0000000000000000000000',
        kind: 'confirmation',
        summary: 'Submit the order form',
        deadlineAt: '2026-11-14T10:03:00.000Z',
      },
    ]);
    expect(resolved.pendingInterventions).toEqual([]);
  });

  it('treats a workflow confirmation as the same wait, without a duplicate', () => {
    const state = replay([ev('intervention_raised'), ev('confirmation_requested')]);
    const after = replay([ev('confirmation_resolved')], state);

    expect(state.pendingInterventions).toHaveLength(1);
    expect(after.pendingInterventions).toEqual([]);
  });

  it('derives a confirmation deadline from its timeout, or none when it waits forever', () => {
    const timed = replay([ev('confirmation_requested')]);
    const open = replay([
      ev('confirmation_requested', {
        request: { ...ev('confirmation_requested').request, timeout_ms: null },
      }),
    ]);

    expect(timed.pendingInterventions[0]?.deadlineAt).toBe('2026-11-14T10:03:00.000Z');
    expect(open.pendingInterventions[0]?.deadlineAt).toBeNull();
  });

  it('records the outcome and clears open work', () => {
    const state = replay([ev('tool_started'), ev('intervention_raised'), ev('run_outcome')]);

    expect(state.outcome).toEqual({
      outcome: 'fulfilled',
      terminationReason: 'model_finished',
      exitCode: 0,
      failureClass: null,
      stopDetail: null,
    });
    expect(state.openTools).toEqual([]);
    expect(state.pendingInterventions).toEqual([]);
    expect(engineState(state)).toBe('idle');
  });

  it('marks an owner_lost outcome as interrupted', () => {
    const state = replay([
      ev('run_outcome', {
        task_outcome: 'partial',
        termination_reason: 'owner_lost',
        exit_code: 2,
      }),
    ]);

    expect(state.outcome).toMatchObject({
      outcome: 'partial',
      terminationReason: 'owner_lost',
      executionState: 'interrupted',
    });
  });

  it('counts deterministic phases and tracks the current one', () => {
    const state = replay([
      ev('search_completed'),
      ev('source_fetched'),
      ev('source_fetched', { status: 'failed', failure_class: 'fetch' }),
      ev('extract_completed'),
    ]);

    expect(state.phase).toBe('extract');
    expect(state.phaseCounts).toEqual({
      searches: 1,
      sourcesOk: 1,
      sourcesFailed: 1,
      extracted: 5,
    });
    expect(replay([ev('synthesize_started')], state).phase).toBe('synthesize');
  });

  it('names each mode by its command word', () => {
    expect(modeOf(['research'])).toBe('research');
    expect(modeOf(['resume'])).toBe('resume');
    expect(modeOf(['config', 'set'])).toBe('other');
    expect(modeOf(null)).toBe('other');
  });
});

describe('@no-llm cockpit reducer: timeline', () => {
  it('pairs a tool finish with its start in place', () => {
    const state = replay([ev('tool_started'), ev('tool_finished')]);

    expect(logEntries(state.timeline)).toEqual([
      {
        type: 'tool',
        seq: 1,
        tool: 'browser_fill',
        summary: 'fields: email',
        status: 'ok',
        result: 'ok',
        durationMs: 120,
        at: ev('tool_started').at,
      },
    ]);
    expect(state.openTools).toEqual([]);
  });

  it('pairs calls of the same tool first in, first out', () => {
    const state = replay([
      ev('tool_started', { summary: 'first' }),
      ev('tool_started', { summary: 'second' }),
      ev('tool_finished', { status: 'error', summary: 'timeout' }),
    ]);

    const rows = logEntries(state.timeline);
    expect(rows.map((row) => (row.type === 'tool' ? [row.summary, row.status] : null))).toEqual([
      ['first', 'error'],
      ['second', 'running'],
    ]);
    expect(state.openTools).toEqual([{ tool: 'browser_fill', index: 1 }]);
  });

  it('shows a finish whose start was never seen on its own row', () => {
    const state = replay([ev('tool_finished', { status: 'denied' })]);

    expect(logEntries(state.timeline)).toMatchObject([
      { type: 'tool', status: 'denied', summary: '' },
    ]);
  });

  it('marks recovery steers and phases as their own rows', () => {
    const state = replay([ev('recovery'), ev('search_completed')]);

    expect(logEntries(state.timeline).map((row) => row.type)).toEqual(['recovery', 'phase']);
  });

  it('sends inspector-routed and unknown kinds to the inspector, and no others', () => {
    const state = replay([
      ev('assistant_text'),
      ev('tool_started'),
      { kind: 'future_kind', at: '2026-11-14T10:00:00.000Z', detail: 1 },
      { not: 'an event' },
    ]);

    expect(logEntries(state.inspected).map((item) => [item.seq, item.kind, item.unknown])).toEqual([
      [1, 'assistant_text', false],
      [3, 'future_kind', true],
      [4, 'unknown', true],
    ]);
  });
});

describe('@no-llm cockpit reducer: engine state', () => {
  it('is thinking once the run speaks, acting with a tool open, idle at the end', () => {
    const started = replay([ev('goal_echo')]);
    const acting = replay([ev('tool_started')], started);
    const between = replay([ev('tool_finished')], acting);

    expect(engineState(started)).toBe('thinking');
    expect(engineState(acting)).toBe('acting');
    expect(engineState(between)).toBe('thinking');
  });

  it('is acting through deterministic phases, never thinking', () => {
    expect(engineState(replay([ev('goal_echo'), ev('search_completed')]))).toBe('acting');
  });

  it('is stalled after a stalled recovery until progress resumes', () => {
    const stalled = replay([ev('recovery')]);
    const resumed = replay([ev('progress')], stalled);
    const turnLimit = replay([ev('recovery', { trigger: 'turn-timeout' })]);

    expect(engineState(stalled)).toBe('stalled');
    expect(stalled.stalledAt).toBe(1);
    expect(engineState(resumed)).toBe('thinking');
    expect(engineState(turnLimit)).toBe('thinking');
  });
});

describe('@no-llm cockpit reducer: scale', () => {
  it('replays 50,000 events within a fixed budget, keeping 2,000 timeline rows', () => {
    const events: unknown[] = [];
    for (let index = 0; index < 25_000; index += 1) {
      events.push(ev('tool_started', { summary: `call ${String(index)}` }), ev('tool_finished'));
    }
    const started = performance.now();

    let state = initialCockpitState('run-1');
    numbered(events).forEach((item) => {
      state = reduceRunEvent(state, item).state;
    });
    const elapsed = performance.now() - started;

    expect(state.lastSeq).toBe(50_000);
    expect(state.timeline.size).toBe(TIMELINE_CAP);
    expect(state.timeline.total).toBe(25_000);
    expect(state.openTools).toEqual([]);
    expect(logEntries(state.timeline).at(-1)).toMatchObject({
      summary: 'call 24999',
      status: 'ok',
    });
    expect(elapsed).toBeLessThan(5_000);
  });

  it('caps the inspector', () => {
    const state = replay(Array.from({ length: INSPECTOR_CAP + 10 }, () => ev('assistant_text')));

    expect(state.inspected.size).toBe(INSPECTOR_CAP);
    expect(state.inspected.total).toBe(INSPECTOR_CAP + 10);
  });
});
