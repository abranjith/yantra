import type { InvocationSummary } from '@yantra/protocol';
import { INVOCATION_ID_PATTERN as PROTOCOL_PATTERN } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  initialCockpitState,
  type CockpitState,
} from '../../../src/features/live/cockpit-state.js';
import {
  DISPLAYED_KINDS,
  DISPLAYED_WORDS,
  deriveDisplayedState,
  type DisplayedInput,
  type DisplayedKind,
} from '../../../src/features/live/displayed-state.js';
import { INVOCATION_ID_PATTERN } from '../../../src/routes/invocation-id.js';

const ID = '01JD2X7Q8R9S0T1V2W3X000001';

function invocation(overrides: Partial<InvocationSummary> = {}): InvocationSummary {
  return {
    invocation_id: ID,
    state: 'running',
    execution_class: 'run',
    path: ['research'],
    run_id: 'run-1',
    queued_at: '2026-11-14T10:00:00.000Z',
    review: null,
    result: null,
    ...overrides,
  };
}

function base(): DisplayedInput {
  return {
    invocation: null,
    connection: { status: 'connected' },
    channel: { state: 'live' },
    cockpit: initialCockpitState('run-1', 'research'),
    stopping: false,
  };
}

type Draft = { -readonly [K in keyof DisplayedInput]: DisplayedInput[K] };

function cockpit(draft: Draft, patch: Partial<CockpitState>): void {
  draft.cockpit = { ...(draft.cockpit ?? initialCockpitState('run-1')), ...patch };
}

/** One way to make each displayed state hold. */
const CONDITIONS: Readonly<Record<DisplayedKind, (draft: Draft) => void>> = {
  disconnected: (draft) => {
    draft.connection = { status: 'disconnected', retryAt: 0 };
  },
  live_view_unavailable: (draft) => {
    draft.channel = { state: 'unavailable', startedByVersion: '0.9.0' };
  },
  worker_not_responding: (draft) => {
    draft.channel = { state: 'not_responding' };
  },
  needs_review: (draft) => {
    draft.invocation = invocation({
      state: 'needs_review',
      run_id: null,
      review: {
        detected_at: '2026-11-14T10:00:00.000Z',
        differences: [{ key: 'model', submitted: 'a', current: 'b', pinnable: true }],
      },
    });
  },
  start_unknown: (draft) => {
    draft.invocation = invocation({ state: 'start_unknown' });
  },
  waiting_for_you: (draft) => {
    cockpit(draft, {
      firstSeq: 1,
      pendingInterventions: [
        {
          interventionId: 'i-1',
          kind: 'confirmation',
          summary: 'Submit the form',
          deadlineAt: null,
        },
      ],
    });
  },
  stopping: (draft) => {
    draft.stopping = true;
  },
  engine_stalled: (draft) => {
    cockpit(draft, { firstSeq: 1, stalledAt: 4 });
  },
  finished: (draft) => {
    cockpit(draft, {
      firstSeq: 1,
      outcome: {
        outcome: 'fulfilled',
        terminationReason: null,
        exitCode: 0,
        failureClass: null,
        stopDetail: null,
        endedAt: '2026-11-14T10:01:00.000Z',
      },
    });
  },
  running: (draft) => {
    cockpit(draft, { firstSeq: 1 });
  },
  starting: (draft) => {
    draft.invocation = invocation({ state: 'spawning' });
  },
  queued: (draft) => {
    draft.invocation = invocation({ state: 'queued', run_id: null, position: 2 });
  },
};

function holding(...kinds: DisplayedKind[]): DisplayedInput {
  const draft = { ...base() } as Draft;
  for (const kind of kinds) CONDITIONS[kind](draft);
  return draft;
}

/** Conditions read from the same field cannot hold together. */
const SAME_FIELD: readonly (readonly DisplayedKind[])[] = [
  ['live_view_unavailable', 'worker_not_responding'],
  ['needs_review', 'start_unknown', 'starting', 'queued'],
];
/** A live-only condition ends with the outcome: these never hold beside `finished`. */
const LIVE_ONLY: readonly DisplayedKind[] = [
  'live_view_unavailable',
  'worker_not_responding',
  'waiting_for_you',
  'stopping',
  'engine_stalled',
];

function exclusive(a: DisplayedKind, b: DisplayedKind): boolean {
  if (SAME_FIELD.some((group) => group.includes(a) && group.includes(b))) return true;
  if ((a === 'finished' && LIVE_ONLY.includes(b)) || (b === 'finished' && LIVE_ONLY.includes(a)))
    return true;
  // starting and queued describe a run with no events yet.
  return (
    (a === 'running' && (b === 'starting' || b === 'queued')) ||
    (b === 'running' && (a === 'starting' || a === 'queued'))
  );
}

describe('@no-llm displayed state: each state', () => {
  it.each(DISPLAYED_KINDS)('derives %s from its condition alone', (kind) => {
    expect(deriveDisplayedState(holding(kind)).kind).toBe(kind);
  });

  it('names every state in words', () => {
    expect(Object.keys(DISPLAYED_WORDS).sort()).toEqual([...DISPLAYED_KINDS].sort());
    expect(DISPLAYED_WORDS.start_unknown).toBe('start outcome unknown');
  });

  it('shows the queue position and offers Cancel', () => {
    const state = deriveDisplayedState(holding('queued'));

    expect(state.position).toBe(2);
    expect(state.detail).toContain('number 2 in line');
    expect(state.nextActions).toEqual([
      expect.objectContaining({
        id: 'cancel',
        label: 'Cancel',
        rpc: { method: 'command.cancel', params: { invocation_id: ID } },
      }),
    ]);
  });

  it('offers the three review choices, or two when the change cannot be pinned', () => {
    const pinnable = deriveDisplayedState(holding('needs_review'));
    const draft = holding('needs_review') as Draft;
    draft.invocation = invocation({
      state: 'needs_review',
      run_id: null,
      review: {
        detected_at: '2026-11-14T10:00:00.000Z',
        differences: [{ key: 'content:/w.yaml', submitted: 'a', current: null, pinnable: false }],
      },
    });
    const content = deriveDisplayedState(draft);

    expect(pinnable.nextActions.map((action) => action.rpc?.params.choice)).toEqual([
      'current',
      'submitted',
      'discard',
    ]);
    expect(pinnable.detail).toContain('model: "a" → "b"');
    expect(content.nextActions.map((action) => action.rpc?.params.choice)).toEqual([
      'current',
      'discard',
    ]);
    expect(content.detail).toContain('/w.yaml (changed)');
  });

  it('asks before starting a start_unknown item again, with the duplicate risk', () => {
    const state = deriveDisplayedState(holding('start_unknown'));
    const start = state.nextActions.find((action) => action.id === 'start_anyway');

    expect(start?.rpc).toEqual({
      method: 'queue.start',
      params: { invocation_id: ID, acknowledge_duplicate_risk: true },
    });
    expect(start?.confirm?.body).toMatch(/repeat its effects/u);
    expect(state.nextActions.map((action) => action.id)).toEqual(['start_anyway', 'discard']);
  });

  it('starts a never_started item again without the duplicate warning', () => {
    const draft = holding() as Draft;
    draft.invocation = invocation({ state: 'never_started' });

    const state = deriveDisplayedState(draft);

    expect(state.kind).toBe('start_unknown');
    expect(state.detail).toBe('This run did not start.');
    expect(state.nextActions[0]?.confirm).toBeUndefined();
  });

  it('points a waiting run at the terminal answer until FEAT-068', () => {
    const state = deriveDisplayedState(holding('waiting_for_you'));

    expect(state.detail).toBe('Submit the form.');
    expect(state.nextActions.map((action) => action.twin)).toEqual([
      { path: ['confirm'], argv: ['run-1', 'grant'] },
      { path: ['confirm'], argv: ['run-1', 'deny'] },
    ]);
  });

  it('says which version started a run whose live view is unavailable', () => {
    const state = deriveDisplayedState(holding('live_view_unavailable'));

    expect(state.detail).toBe(
      'Started by Yantra 0.9.0; live view unavailable. The run continues and its result will appear here.',
    );
    expect(state.nextActions).toEqual([expect.objectContaining({ href: '/runs/run-1' })]);
  });

  it('offers Stop for a silent worker only when the app launched the run', () => {
    expect(deriveDisplayedState(holding('worker_not_responding')).nextActions).toEqual([]);

    const launched = holding('worker_not_responding') as Draft;
    launched.invocation = invocation();
    expect(deriveDisplayedState(launched).nextActions.map((action) => action.label)).toEqual([
      'Stop',
    ]);
  });

  it('lets the user keep waiting through one stall, until the next', () => {
    const draft = holding('engine_stalled') as Draft;
    draft.acknowledgedStall = 4;
    expect(deriveDisplayedState(draft).kind).toBe('running');

    cockpit(draft, { stalledAt: 9 });
    expect(deriveDisplayedState(draft).kind).toBe('engine_stalled');
  });

  it('says how an interrupted run ended', () => {
    const draft = holding('finished') as Draft;
    cockpit(draft, {
      outcome: { ...draft.cockpit!.outcome!, outcome: 'partial', executionState: 'interrupted' },
    });

    expect(deriveDisplayedState(draft).detail).toBe(
      'The run ended interrupted · partial: its process was lost and the run was reconciled.',
    );
  });

  it('finishes a discarded or finished invocation with no run events', () => {
    const discarded = holding() as Draft;
    discarded.cockpit = null;
    discarded.invocation = invocation({ state: 'discarded', run_id: null });
    const finished = holding() as Draft;
    finished.cockpit = null;
    finished.invocation = invocation({
      state: 'finished',
      result: { exit_code: 3, finished_at: '2026-11-14T10:00:00.000Z' },
    });

    expect(deriveDisplayedState(discarded)).toMatchObject({
      kind: 'finished',
      detail: 'Discarded before it started.',
    });
    expect(deriveDisplayedState(finished)).toMatchObject({
      kind: 'finished',
      detail: 'Finished with exit code 3.',
    });
  });

  it('shows starting for a run followed by ID before its first event', () => {
    expect(deriveDisplayedState(base()).kind).toBe('starting');
  });
});

describe('@no-llm displayed state: precedence', () => {
  const pairs: [DisplayedKind, DisplayedKind][] = [];
  DISPLAYED_KINDS.forEach((higher, index) => {
    for (const lower of DISPLAYED_KINDS.slice(index + 1)) {
      if (!exclusive(higher, lower)) pairs.push([higher, lower]);
    }
  });

  it('covers every pair that can hold together', () => {
    expect(pairs.length).toBeGreaterThan(40);
  });

  it.each(pairs)('%s wins over %s', (higher, lower) => {
    expect(deriveDisplayedState(holding(lower, higher)).kind).toBe(higher);
    expect(deriveDisplayedState(holding(higher, lower)).kind).toBe(higher);
  });
});

describe('@no-llm displayed state: next actions', () => {
  it('gives every action an engineered path', () => {
    const inputs = DISPLAYED_KINDS.map((kind) => {
      const draft = holding(kind) as Draft;
      draft.invocation ??= invocation();
      return draft;
    });

    for (const input of inputs) {
      for (const action of deriveDisplayedState(input).nextActions) {
        const paths = [action.rpc, action.href, action.local, action.twin].filter(
          (path) => path !== undefined,
        );
        expect({ id: action.id, paths: paths.length }).toEqual({ id: action.id, paths: 1 });
      }
    }
  });

  it('uses only RPC methods the host serves', () => {
    const served = new Set([
      'command.cancel',
      'queue.start',
      'queue.discard',
      'queue.resolve_review',
    ]);
    for (const kind of DISPLAYED_KINDS) {
      const draft = holding(kind) as Draft;
      draft.invocation ??= invocation();
      for (const action of deriveDisplayedState(draft).nextActions) {
        if (action.rpc !== undefined) expect(served).toContain(action.rpc.method);
      }
    }
  });

  it('restates the protocol invocation ID pattern exactly', () => {
    expect(INVOCATION_ID_PATTERN.source).toBe(PROTOCOL_PATTERN.source);
  });
});
