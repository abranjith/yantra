/**
 * The cockpit's model of one run (FEAT-067 TASK-001), built by a pure
 * reducer over the run's sequence-numbered events.
 *
 * - **Seq rule.** An event at or below `lastSeq` is a duplicate and changes
 *   nothing. An event above `lastSeq + 1` is a gap: it is not applied, and the
 *   caller resubscribes from `lastSeq + 1`. So the state is always the replay
 *   of a gap-free prefix of `run-events.jsonl`.
 * - **Bounded memory.** The timeline keeps the newest 2,000 entries and the
 *   inspector the newest 500; older entries stay readable in the run result's
 *   JSONL viewer (FEAT-066). Each event costs O(1) plus one log chunk; there
 *   is no full-state copy, so a 50,000-event replay stays responsive.
 * - **Untrusted text.** Goals, summaries and URLs are page- or model-derived;
 *   they are stored as plain strings and rendered through React escaping only.
 */

import type {
  LiveItem,
  RunEvent,
  RunEventKind,
  RunEventOf,
  TaskOutcome,
  TerminationReason,
} from '@yantra/protocol';

import { appendLog, emptyLog, logAt, replaceLog, type BoundedLog } from './bounded-log.js';
import { isInspected, isKnownKind } from './event-routes.js';

/** Newest timeline entries held. */
export const TIMELINE_CAP = 2_000;
/** Newest inspector entries held. */
export const INSPECTOR_CAP = 500;
/** Longest goal shown, mirroring the CLI's goal echo (`GOAL_ECHO_MAX_CHARS`). */
export const GOAL_MAX_CHARS = 200;

/** The command a run was started by, as the CLI names it. */
export type CockpitMode = 'ask' | 'research' | 'do' | 'run' | 'resume' | 'other';

/** One declared requirement, live. */
export type LiveRequirement = LiveItem;

/** One budget dimension of the latest `budget_snapshot`. */
export interface BudgetDimension {
  readonly name: string;
  readonly used: number;
  readonly limit: number | null;
  readonly unit: 'ms' | 'count' | 'bytes' | 'pixels';
}

/** The latest budget snapshot. */
export interface BudgetView {
  readonly dimensions: readonly BudgetDimension[];
  readonly at: string;
}

/** How a tool call stands. */
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'aborted';

/** A deterministic `ask`/`research` phase. */
export type Phase = 'search' | 'fetch' | 'extract' | 'synthesize';

/** The tone of a workflow or advisory timeline row. */
export type RowTone = 'neutral' | 'ok' | 'warn' | 'error';

/** One RunTimeline row. */
export type TimelineEntry =
  | {
      readonly type: 'tool';
      readonly seq: number;
      readonly tool: string;
      readonly summary: string;
      readonly status: ToolStatus;
      /** The finish summary (status and error code only), once finished. */
      readonly result: string | null;
      readonly durationMs: number | null;
      readonly at: string;
    }
  | {
      readonly type: 'recovery';
      readonly seq: number;
      readonly rung: 'steer' | 'freeze' | 'stop';
      readonly trigger: 'stalled' | 'turn-timeout';
      readonly summary: string;
      readonly at: string;
    }
  | {
      readonly type: 'phase';
      readonly seq: number;
      readonly phase: Phase;
      readonly text: string;
      readonly at: string;
    }
  | {
      readonly type: 'step';
      readonly seq: number;
      readonly kind: string;
      readonly text: string;
      readonly tone: RowTone;
      readonly at: string;
    };

/** One event shown in the EventInspector. */
export interface InspectedEvent {
  readonly seq: number;
  readonly kind: string;
  /** True for a kind this build does not know (a newer worker). */
  readonly unknown: boolean;
  readonly event: unknown;
}

/** A wait for a person that is still open. */
export interface PendingIntervention {
  readonly interventionId: string;
  readonly kind: string;
  readonly summary: string;
  readonly deadlineAt: string | null;
}

/** How the run ended. */
export interface CockpitOutcome {
  readonly outcome: TaskOutcome;
  readonly terminationReason: TerminationReason | null;
  /** `interrupted` when the owner was lost and the run was reconciled (FEAT-064). */
  readonly executionState?: 'interrupted';
  readonly exitCode: number;
  readonly failureClass: string | null;
  readonly stopDetail: string | null;
}

/** What the engine is doing, for the Bindu. */
export type EngineState = 'idle' | 'thinking' | 'acting' | 'stalled';

/** Counts of the deterministic phases, for the Understood panel. */
export interface PhaseCounts {
  readonly searches: number;
  readonly sourcesOk: number;
  readonly sourcesFailed: number;
  readonly extracted: number;
}

/** The latest contract revision. */
export interface ContractView {
  readonly revision: number;
  readonly summary: string;
}

/** See the module comment. */
export interface CockpitState {
  readonly runId: string;
  /** Highest seq applied; 0 before any (run-events.jsonl seqs start at 1). */
  readonly lastSeq: number;
  readonly mode: CockpitMode;
  readonly goal: string | null;
  readonly startedAt: string | null;
  readonly contract: ContractView | null;
  readonly requirements: readonly LiveRequirement[];
  readonly progressSummary: string | null;
  readonly capabilityGaps: readonly { readonly item: string; readonly summary: string }[];
  readonly budgets: BudgetView | null;
  readonly timeline: BoundedLog<TimelineEntry>;
  /** Timeline indexes of tool calls started and not yet finished, oldest first. */
  readonly openTools: readonly { readonly tool: string; readonly index: number }[];
  /** Seq of the latest `stalled` recovery with no progress since, or null. */
  readonly stalledAt: number | null;
  readonly pendingInterventions: readonly PendingIntervention[];
  readonly outcome: CockpitOutcome | null;
  readonly inspected: BoundedLog<InspectedEvent>;
  readonly phase: Phase | null;
  readonly phaseCounts: PhaseCounts;
  /** Seq of the first event applied, so the cockpit knows the run has spoken. */
  readonly firstSeq: number | null;
}

/** The result of applying one event. */
export interface ReduceResult {
  readonly state: CockpitState;
  /** True when the event skipped ahead; resubscribe from `state.lastSeq + 1`. */
  readonly gap: boolean;
}

/** One sequence-numbered event as the host relays it. */
export interface SeqEvent {
  readonly seq: number;
  readonly event: unknown;
}

/** The state before any event of `runId`. */
export function initialCockpitState(runId: string, mode: CockpitMode = 'other'): CockpitState {
  return {
    runId,
    lastSeq: 0,
    mode,
    goal: null,
    startedAt: null,
    contract: null,
    requirements: [],
    progressSummary: null,
    capabilityGaps: [],
    budgets: null,
    timeline: emptyLog(TIMELINE_CAP),
    openTools: [],
    stalledAt: null,
    pendingInterventions: [],
    outcome: null,
    inspected: emptyLog(INSPECTOR_CAP),
    phase: null,
    phaseCounts: { searches: 0, sourcesOk: 0, sourcesFailed: 0, extracted: 0 },
    firstSeq: null,
  };
}

/** The command word of a path, as a {@link CockpitMode}. */
export function modeOf(path: readonly string[] | null | undefined): CockpitMode {
  const word = path?.[0];
  return word === 'ask' ||
    word === 'research' ||
    word === 'do' ||
    word === 'run' ||
    word === 'resume'
    ? word
    : 'other';
}

// eslint-disable-next-line no-control-regex -- the point is to remove control characters.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/gu;

/**
 * The goal from a `goal_echo` display line (`goal: "…"`): control characters
 * stripped and capped at {@link GOAL_MAX_CHARS} characters, with an ellipsis
 * when cut.
 */
export function goalFromEcho(display: string): string {
  let text = display.startsWith('goal: ') ? display.slice('goal: '.length) : display;
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  const clean = text.replace(CONTROL, ' ').trim();
  const chars = [...clean];
  return chars.length > GOAL_MAX_CHARS ? `${chars.slice(0, GOAL_MAX_CHARS - 1).join('')}…` : clean;
}

/** What the engine is doing; see {@link EngineState}. */
export function engineState(state: CockpitState): EngineState {
  if (state.outcome !== null || state.firstSeq === null) return 'idle';
  if (state.stalledAt !== null) return 'stalled';
  if (state.openTools.length > 0) return 'acting';
  // A deterministic run has phases and no model turns: it is acting, never thinking.
  if (state.phase !== null) return 'acting';
  return 'thinking';
}

function kindOf(event: unknown): string | null {
  if (event === null || typeof event !== 'object') return null;
  const kind = (event as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

function addTimeline(state: CockpitState, entry: TimelineEntry): CockpitState {
  return { ...state, timeline: appendLog(state.timeline, entry) };
}

function step(seq: number, kind: string, text: string, tone: RowTone, at: string): TimelineEntry {
  return { type: 'step', seq, kind, text, tone, at };
}

function phaseRow(seq: number, phase: Phase, text: string, at: string): TimelineEntry {
  return { type: 'phase', seq, phase, text, at };
}

function withPhase(state: CockpitState, phase: Phase, counts: Partial<PhaseCounts>): CockpitState {
  return { ...state, phase, phaseCounts: { ...state.phaseCounts, ...counts } };
}

function finishTool(
  state: CockpitState,
  seq: number,
  event: RunEventOf<'tool_finished'>,
): CockpitState {
  const openIndex = state.openTools.findIndex((open) => open.tool === event.tool);
  const finished = {
    status: event.status,
    result: event.summary,
    durationMs: event.durationMs,
  } as const;
  if (openIndex >= 0) {
    const open = state.openTools[openIndex]!;
    const started = logAt(state.timeline, open.index);
    const openTools = state.openTools.filter((_, index) => index !== openIndex);
    if (started?.type === 'tool') {
      return {
        ...state,
        openTools,
        timeline: replaceLog(state.timeline, open.index, { ...started, ...finished }),
      };
    }
    state = { ...state, openTools };
  }
  // The start scrolled out of the window or was never observed: show the finish on its own row.
  return addTimeline(state, {
    type: 'tool',
    seq,
    tool: event.tool,
    summary: '',
    ...finished,
    at: event.at,
  });
}

function addPending(state: CockpitState, pending: PendingIntervention): CockpitState {
  if (state.pendingInterventions.some((item) => item.interventionId === pending.interventionId)) {
    return state;
  }
  return { ...state, pendingInterventions: [...state.pendingInterventions, pending] };
}

function removePending(state: CockpitState, id: string): CockpitState {
  if (!state.pendingInterventions.some((item) => item.interventionId === id)) return state;
  return {
    ...state,
    pendingInterventions: state.pendingInterventions.filter((item) => item.interventionId !== id),
  };
}

function eventTime(event: unknown): string | null {
  const at = (event as { at?: unknown }).at;
  return typeof at === 'string' ? at : null;
}

/** Applies one known event (seq already checked). */
function apply(state: CockpitState, seq: number, event: RunEvent): CockpitState {
  switch (event.kind) {
    case 'task_queued':
      return state;
    case 'task_started':
      return addTimeline(state, step(seq, event.kind, 'task started', 'neutral', event.at));
    case 'step_started':
      return addTimeline(
        state,
        step(seq, event.kind, `step ${event.step_id} (${event.step_type})`, 'neutral', event.at),
      );
    case 'step_retry':
      return addTimeline(
        state,
        step(
          seq,
          event.kind,
          `retry ${event.step_id} #${event.attempt}: ${event.reason}`,
          'warn',
          event.at,
        ),
      );
    case 'step_completed':
      return addTimeline(
        state,
        step(seq, event.kind, `step ${event.step_id} done`, 'ok', event.at),
      );
    case 'llm_step_skipped':
      return addTimeline(
        state,
        step(
          seq,
          event.kind,
          `step ${event.step_id} passed through: ${event.reason}`,
          'warn',
          event.at,
        ),
      );
    case 'checkpoint_saved':
      return addTimeline(
        state,
        step(seq, event.kind, `checkpoint after ${event.after_step_id}`, 'neutral', event.at),
      );
    case 'human_handoff_requested':
      return addTimeline(
        state,
        step(seq, event.kind, `handoff at ${event.step_id}: ${event.reason}`, 'warn', event.at),
      );
    case 'task_completed':
      return addTimeline(state, step(seq, event.kind, 'task completed', 'ok', event.at));
    case 'task_failed':
      return addTimeline(
        state,
        step(seq, event.kind, `task failed: ${event.failure_class}`, 'error', event.at),
      );
    case 'validation_failed':
      return addTimeline(
        state,
        step(
          seq,
          event.kind,
          `validation failed at ${event.path}: ${event.message}`,
          'error',
          event.at,
        ),
      );
    case 'scope_violation':
      return addTimeline(
        state,
        step(
          seq,
          event.kind,
          `scope violation: ${event.attempted_verb} at ${event.step_id}`,
          'error',
          event.at,
        ),
      );
    case 'task_resumed':
      return addTimeline(
        state,
        step(seq, event.kind, `resumed from ${event.resume_step_id}`, 'neutral', event.at),
      );
    case 'chrome_drift_warning':
      return addTimeline(
        state,
        step(
          seq,
          event.kind,
          `Chrome ${event.current_chrome_major} differs from recorded ${event.recorded_chrome_major}`,
          'warn',
          event.at,
        ),
      );
    case 'synthesis_completed':
      return addTimeline(
        withPhase(state, 'synthesize', {}),
        phaseRow(
          seq,
          'synthesize',
          `synthesis (${event.strategy}): ${event.sources_used} of ${event.sources_in} sources used`,
          event.at,
        ),
      );
    case 'research_hop_completed':
      return addTimeline(
        state,
        phaseRow(
          seq,
          'search',
          `hop ${event.hop_index}: ${event.docs_kept} of ${event.docs_fetched} documents kept`,
          event.at,
        ),
      );
    case 'confirmation_requested':
      return addPending(state, {
        interventionId: event.request.confirmation_id,
        kind: 'confirmation',
        summary: event.request.description,
        deadlineAt:
          event.request.timeout_ms === null
            ? null
            : new Date(
                Date.parse(event.request.requested_at) + event.request.timeout_ms,
              ).toISOString(),
      });
    case 'confirmation_resolved':
      return removePending(state, event.confirmation_id);
    case 'discovery_cycle_completed':
    case 'discovery_session_completed':
    case 'assistant_text':
    case 'receipt_written':
    case 'event_omitted':
      return state;
    case 'recovery':
      return addTimeline(
        { ...state, stalledAt: event.trigger === 'stalled' ? seq : state.stalledAt },
        {
          type: 'recovery',
          seq,
          rung: event.rung,
          trigger: event.trigger,
          summary: event.summary,
          at: event.at,
        },
      );
    case 'progress':
      return {
        ...state,
        requirements: event.items,
        progressSummary: event.summary,
        stalledAt: null,
      };
    case 'tool_started': {
      const index = state.timeline.total;
      return {
        ...addTimeline(state, {
          type: 'tool',
          seq,
          tool: event.tool,
          summary: event.summary,
          status: 'running',
          result: null,
          durationMs: null,
          at: event.at,
        }),
        openTools: [...state.openTools, { tool: event.tool, index }],
      };
    }
    case 'tool_finished':
      return finishTool(state, seq, event);
    case 'contract_declared':
      return { ...state, contract: { revision: event.revision, summary: event.summary } };
    case 'capability_gap':
      return state.capabilityGaps.some((gap) => gap.item === event.item)
        ? state
        : {
            ...state,
            capabilityGaps: [...state.capabilityGaps, { item: event.item, summary: event.summary }],
          };
    case 'goal_echo':
      return { ...state, goal: goalFromEcho(event.display) };
    case 'run_warning':
      return addTimeline(state, step(seq, event.kind, `warning: ${event.text}`, 'warn', event.at));
    case 'budget_snapshot':
      return { ...state, budgets: { dimensions: event.dimensions, at: event.at } };
    case 'artifact_saved':
      return addTimeline(state, step(seq, event.kind, `saved ${event.path}`, 'neutral', event.at));
    case 'intervention_raised':
      return addPending(state, {
        interventionId: event.intervention_id,
        kind: event.intervention_kind,
        summary: event.request.description,
        deadlineAt: event.deadline_at,
      });
    case 'intervention_resolved':
      return removePending(state, event.intervention_id);
    case 'run_outcome':
      return {
        ...state,
        openTools: [],
        stalledAt: null,
        pendingInterventions: [],
        outcome: {
          outcome: event.task_outcome,
          terminationReason: event.termination_reason,
          ...(event.termination_reason === 'owner_lost'
            ? { executionState: 'interrupted' as const }
            : {}),
          exitCode: event.exit_code,
          failureClass: event.failure_class,
          stopDetail: event.stop_detail,
        },
      };
    case 'search_completed':
      return addTimeline(
        withPhase(state, 'search', { searches: state.phaseCounts.searches + 1 }),
        phaseRow(
          seq,
          'search',
          `search ${event.provider}${event.cached ? ' (cached)' : ''}: ${event.result_count} results for "${event.query}"`,
          event.at,
        ),
      );
    case 'source_fetched':
      return addTimeline(
        withPhase(
          state,
          'fetch',
          event.status === 'ok'
            ? { sourcesOk: state.phaseCounts.sourcesOk + 1 }
            : { sourcesFailed: state.phaseCounts.sourcesFailed + 1 },
        ),
        phaseRow(seq, 'fetch', `fetch ${event.status} ${event.url}`, event.at),
      );
    case 'extract_completed':
      return addTimeline(
        withPhase(state, 'extract', { extracted: state.phaseCounts.extracted + event.extracted }),
        phaseRow(
          seq,
          'extract',
          `extract: ${event.extracted} extracted, ${event.failed} failed`,
          event.at,
        ),
      );
    case 'synthesize_started':
      return addTimeline(
        withPhase(state, 'synthesize', {}),
        phaseRow(
          seq,
          'synthesize',
          `synthesize (${event.strategy}) from ${event.sources_in} sources`,
          event.at,
        ),
      );
  }
}

const STARTED_BY: ReadonlySet<string> = new Set<RunEventKind>([
  'task_started',
  'receipt_written',
  'goal_echo',
]);

/**
 * Applies one event to the state; see the module comment for the seq rule.
 * Pure: the input state is never mutated.
 */
export function reduceRunEvent(state: CockpitState, { seq, event }: SeqEvent): ReduceResult {
  if (!Number.isInteger(seq) || seq <= state.lastSeq) return { state, gap: false };
  if (seq > state.lastSeq + 1) return { state, gap: true };
  const kind = kindOf(event);
  let next: CockpitState = {
    ...state,
    lastSeq: seq,
    firstSeq: state.firstSeq ?? seq,
  };
  if (kind === null) {
    // Not even a kind: keep it inspectable rather than drop it.
    return {
      state: {
        ...next,
        inspected: appendLog(next.inspected, { seq, kind: 'unknown', unknown: true, event }),
      },
      gap: false,
    };
  }
  if (next.startedAt === null && STARTED_BY.has(kind)) {
    next = { ...next, startedAt: eventTime(event) };
  }
  const known = isKnownKind(kind);
  if (known) next = apply(next, seq, event as RunEvent);
  if (!known || isInspected(kind)) {
    next = {
      ...next,
      inspected: appendLog(next.inspected, { seq, kind, unknown: !known, event }),
    };
  }
  return { state: next, gap: false };
}

/** Applies `events` in order, stopping at the first gap. */
export function reduceRunEvents(state: CockpitState, events: readonly SeqEvent[]): ReduceResult {
  let current = state;
  for (const item of events) {
    const result = reduceRunEvent(current, item);
    if (result.gap) return { state: current, gap: true };
    current = result.state;
  }
  return { state: current, gap: false };
}
