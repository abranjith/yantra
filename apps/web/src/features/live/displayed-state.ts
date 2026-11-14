/**
 * The cockpit's displayed state (FEAT-067 TASK-005, plan §8): one honest
 * line about the run, with what can be done about it.
 *
 * Several conditions can hold at once; the highest wins:
 *
 *   disconnected > live_view_unavailable > worker_not_responding > needs_review
 *   > start_unknown > waiting_for_you > stopping > engine_stalled > finished
 *   > running > starting > queued
 *
 * Every next action names an engineered path (memory -> Coding Standards):
 * an RPC the host serves, an app route, a local reconnect, or a CLI twin a
 * person can run. Words are the CLI's.
 */

import type { InvocationSummary } from '@yantra/protocol';

import type { ConnectionState } from '../../host/connection-store.js';

import { engineState, type CockpitState } from './cockpit-state.js';
import type { ChannelStatus } from './run-stream.js';

/** Every displayed state, highest precedence first. */
export const DISPLAYED_KINDS = [
  'disconnected',
  'live_view_unavailable',
  'worker_not_responding',
  'needs_review',
  'start_unknown',
  'waiting_for_you',
  'stopping',
  'engine_stalled',
  'finished',
  'running',
  'starting',
  'queued',
] as const;

export type DisplayedKind = (typeof DISPLAYED_KINDS)[number];

/** How each state reads, in the CLI's words. */
export const DISPLAYED_WORDS: Readonly<Record<DisplayedKind, string>> = {
  disconnected: 'disconnected',
  live_view_unavailable: 'live view unavailable',
  worker_not_responding: 'worker not responding',
  needs_review: 'needs review',
  start_unknown: 'start outcome unknown',
  waiting_for_you: 'waiting for you',
  stopping: 'stopping',
  engine_stalled: 'engine stalled',
  finished: 'finished',
  running: 'running',
  starting: 'starting',
  queued: 'queued',
};

/** An RPC the host serves. */
export interface ActionRpc {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** A command a person can run in a terminal instead (shown as a CLI twin). */
export interface ActionTwin {
  readonly path: readonly string[];
  readonly argv: readonly string[];
}

/** One thing the user can do about the displayed state. */
export interface NextAction {
  readonly id: string;
  readonly label: string;
  readonly rpc?: ActionRpc;
  /** An app route to open. */
  readonly href?: string;
  /** A client-side path: reconnect now, or acknowledge and keep waiting. */
  readonly local?: 'reconnect' | 'keep_waiting';
  readonly twin?: ActionTwin;
  /** Ask before acting: the warning the confirmation shows. */
  readonly confirm?: { readonly title: string; readonly body: string };
  /** The action that changes or discards something irreversibly. */
  readonly tone?: 'primary' | 'secondary' | 'danger';
}

/** See the module comment. */
export interface DisplayedState {
  readonly kind: DisplayedKind;
  readonly detail: string;
  /** The 1-based queue position while queued. */
  readonly position: number | null;
  readonly nextActions: readonly NextAction[];
}

/** What the derivation reads. */
export interface DisplayedInput {
  /** The app invocation that launched the run, when there is one. */
  readonly invocation: InvocationSummary | null;
  readonly connection: ConnectionState;
  readonly channel: ChannelStatus;
  /** The run's cockpit state, once a run ID exists. */
  readonly cockpit: CockpitState | null;
  /** The user pressed Stop and no outcome has arrived yet. */
  readonly stopping: boolean;
  /** The user chose to keep waiting through the current stall (its recovery seq). */
  readonly acknowledgedStall?: number | null;
}

const STARTING_STATES: ReadonlySet<string> = new Set(['reserved', 'spawning', 'claimed']);

function cancelAction(invocationId: string, label: string): NextAction {
  return {
    id: 'cancel',
    label,
    rpc: { method: 'command.cancel', params: { invocation_id: invocationId } },
    tone: 'secondary',
  };
}

function resultAction(runId: string, label = 'Open the run result'): NextAction {
  return { id: 'open_result', label, href: `/runs/${runId}` };
}

function differencesText(invocation: InvocationSummary): string {
  const differences = invocation.review?.differences ?? [];
  const shown = differences.slice(0, 3).map((difference) => {
    const key = difference.key.startsWith('content:')
      ? `${difference.key.slice('content:'.length)} (changed)`
      : `${difference.key}: ${JSON.stringify(difference.submitted)} → ${JSON.stringify(difference.current)}`;
    return key;
  });
  const more = differences.length > 3 ? ` and ${String(differences.length - 3)} more` : '';
  return shown.length === 0 ? '' : ` ${shown.join('; ')}${more}.`;
}

function needsReview(invocation: InvocationSummary): DisplayedState {
  const differences = invocation.review?.differences ?? [];
  const pinnable = differences.length > 0 && differences.every((difference) => difference.pinnable);
  const resolve = (choice: string): ActionRpc => ({
    method: 'queue.resolve_review',
    params: { invocation_id: invocation.invocation_id, choice },
  });
  return {
    kind: 'needs_review',
    detail: `Settings changed while this was queued.${differencesText(invocation)}`,
    position: null,
    nextActions: [
      {
        id: 'review_current',
        label: 'Start with current settings',
        rpc: resolve('current'),
        tone: 'primary',
      },
      ...(pinnable
        ? [
            {
              id: 'review_submitted',
              label: 'Start with the settings shown when queued',
              rpc: resolve('submitted'),
            },
          ]
        : []),
      { id: 'review_discard', label: 'Discard', rpc: resolve('discard'), tone: 'danger' },
    ],
  };
}

function startUnknown(invocation: InvocationSummary): DisplayedState {
  const id = invocation.invocation_id;
  const discard: NextAction = {
    id: 'discard',
    label: 'Discard',
    rpc: { method: 'queue.discard', params: { invocation_id: id } },
    tone: 'secondary',
  };
  if (invocation.state === 'never_started') {
    return {
      kind: 'start_unknown',
      detail: 'This run did not start.',
      position: null,
      nextActions: [
        {
          id: 'start_again',
          label: 'Start again',
          rpc: { method: 'queue.start', params: { invocation_id: id } },
          tone: 'primary',
        },
        discard,
      ],
    };
  }
  return {
    kind: 'start_unknown',
    detail: 'Yantra cannot tell whether this run started. It may already have run.',
    position: null,
    nextActions: [
      {
        id: 'start_anyway',
        label: 'Start anyway',
        rpc: {
          method: 'queue.start',
          params: { invocation_id: id, acknowledge_duplicate_risk: true },
        },
        confirm: {
          title: 'Start this run again?',
          body: 'The earlier start may already have run, so starting again may repeat its effects, such as a submitted form.',
        },
        tone: 'danger',
      },
      discard,
    ],
  };
}

function waitingForYou(cockpit: CockpitState): DisplayedState {
  const pending = cockpit.pendingInterventions[0]!;
  const deadline = pending.deadlineAt === null ? '' : ` It waits until ${pending.deadlineAt}.`;
  // STUB until FEAT-068 adds the in-app GuardedSwitch: answer in the terminal.
  return {
    kind: 'waiting_for_you',
    detail: `${pending.summary}.${deadline}`.replace(/\.\./gu, '.'),
    position: null,
    nextActions: [
      {
        id: 'answer_grant',
        label: 'Answer in the terminal: grant',
        twin: { path: ['confirm'], argv: [cockpit.runId, 'grant'] },
      },
      {
        id: 'answer_deny',
        label: 'Answer in the terminal: deny',
        twin: { path: ['confirm'], argv: [cockpit.runId, 'deny'] },
      },
    ],
  };
}

function finished(cockpit: CockpitState): DisplayedState {
  const outcome = cockpit.outcome!;
  const word =
    outcome.executionState === 'interrupted' ? `interrupted · ${outcome.outcome}` : outcome.outcome;
  const detail =
    outcome.executionState === 'interrupted'
      ? `The run ended ${word}: its process was lost and the run was reconciled.`
      : `The run ended ${word}.`;
  return {
    kind: 'finished',
    detail,
    position: null,
    nextActions: [resultAction(cockpit.runId, 'Open the result')],
  };
}

function finishedInvocation(invocation: InvocationSummary): DisplayedState {
  if (invocation.state === 'discarded') {
    return {
      kind: 'finished',
      detail: 'Discarded before it started.',
      position: null,
      nextActions: [{ id: 'mission', label: 'Start something new', href: '/mission' }],
    };
  }
  const code = invocation.result?.exit_code;
  return {
    kind: 'finished',
    detail: code === undefined ? 'Finished.' : `Finished with exit code ${String(code)}.`,
    position: null,
    nextActions:
      invocation.run_id === null
        ? [{ id: 'mission', label: 'Start something new', href: '/mission' }]
        : [resultAction(invocation.run_id, 'Open the result')],
  };
}

/** Computes the displayed state; pure. See the module comment. */
export function deriveDisplayedState(input: DisplayedInput): DisplayedState {
  const { invocation, connection, channel, cockpit, stopping } = input;
  const runId = cockpit?.runId ?? invocation?.run_id ?? null;
  const outcome = cockpit?.outcome ?? null;
  const live = outcome === null;
  const stop = invocation === null || !live ? [] : [cancelAction(invocation.invocation_id, 'Stop')];

  if (connection.status === 'disconnected') {
    return {
      kind: 'disconnected',
      detail: 'The connection to Yantra on this computer dropped. Runs keep going; reconnecting…',
      position: null,
      nextActions: [{ id: 'reconnect', label: 'Retry now', local: 'reconnect' }],
    };
  }
  if (channel.state === 'unavailable' && live && runId !== null) {
    const version = channel.startedByVersion ?? 'another version';
    return {
      kind: 'live_view_unavailable',
      detail: `Started by Yantra ${version}; live view unavailable. The run continues and its result will appear here.`,
      position: null,
      nextActions: [resultAction(runId)],
    };
  }
  if (channel.state === 'not_responding' && live) {
    return {
      kind: 'worker_not_responding',
      detail: 'The run’s worker has not answered for 30 seconds.',
      position: null,
      nextActions: stop,
    };
  }
  if (invocation?.state === 'needs_review') return needsReview(invocation);
  if (invocation?.state === 'start_unknown' || invocation?.state === 'never_started') {
    return startUnknown(invocation);
  }
  if (cockpit !== null && live && cockpit.pendingInterventions.length > 0)
    return waitingForYou(cockpit);
  if (stopping && live) {
    return { kind: 'stopping', detail: 'Stopping…', position: null, nextActions: [] };
  }
  if (
    cockpit !== null &&
    live &&
    engineState(cockpit) === 'stalled' &&
    cockpit.stalledAt !== (input.acknowledgedStall ?? null)
  ) {
    return {
      kind: 'engine_stalled',
      detail: 'The engine made no progress, so recovery stepped in. It may still finish.',
      position: null,
      nextActions: [{ id: 'keep_waiting', label: 'Keep waiting', local: 'keep_waiting' }, ...stop],
    };
  }
  if (cockpit !== null && outcome !== null) return finished(cockpit);
  if (
    invocation !== null &&
    (invocation.state === 'finished' || invocation.state === 'discarded')
  ) {
    return finishedInvocation(invocation);
  }
  if (cockpit?.firstSeq != null) {
    return { kind: 'running', detail: 'Running.', position: null, nextActions: stop };
  }
  if (invocation?.state === 'queued') {
    const position = invocation.position ?? null;
    return {
      kind: 'queued',
      detail:
        position === null
          ? 'Queued: it starts when a slot is free (at most two runs at once).'
          : `Queued: number ${String(position)} in line; it starts when a slot is free (at most two runs at once).`,
      position,
      nextActions: [cancelAction(invocation.invocation_id, 'Cancel')],
    };
  }
  if (
    invocation !== null &&
    (STARTING_STATES.has(invocation.state) || invocation.state === 'running')
  ) {
    return { kind: 'starting', detail: 'Starting…', position: null, nextActions: stop };
  }
  // A run followed by ID with nothing recorded yet.
  return { kind: 'starting', detail: 'Starting…', position: null, nextActions: stop };
}
