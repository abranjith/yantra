/**
 * Valid `RunEvent` factories for the cockpit suites (FEAT-067): one builder
 * per kind, typed against the protocol union so a shape change breaks here.
 */

import { RunEvent, type RunEventKind } from '@yantra/protocol';

export const AT = '2026-11-14T10:00:00.000Z';

type Of<K extends RunEventKind> = Extract<RunEvent, { readonly kind: K }>;

const TASK = { task_id: 'task-1', at: AT } as const;

const CONFIRMATION_REQUEST = {
  confirmation_id: '01JCONFIRM00000000000000000',
  run_id: 'run-1',
  step_id: 'submit',
  action_kind: 'click',
  host: 'shop.test',
  description: 'Submit the order form',
  expected_cost: null,
  consequence: 'unknown',
  requested_at: AT,
  timeout_ms: 180_000,
} as const;

/**
 * Kinds whose sample is not schema-valid: a discovery cycle record is large and
 * irrelevant to the cockpit, which only routes it to the inspector.
 */
export const UNVALIDATED_SAMPLES: readonly RunEventKind[] = ['discovery_cycle_completed'];

/** One event of every kind, in `RUN_EVENT_KINDS` order; valid except {@link UNVALIDATED_SAMPLES}. */
export const SAMPLE_EVENTS: { readonly [K in RunEventKind]: Of<K> } = {
  task_queued: { ...TASK, kind: 'task_queued' },
  task_started: { ...TASK, kind: 'task_started' },
  step_started: { ...TASK, kind: 'step_started', step_id: 'open', step_type: 'navigate' },
  step_retry: {
    ...TASK,
    kind: 'step_retry',
    step_id: 'open',
    attempt: 2,
    reason: 'navigation_timeout',
  },
  step_completed: { ...TASK, kind: 'step_completed', step_id: 'open', capture_keys: [] },
  llm_step_skipped: {
    ...TASK,
    kind: 'llm_step_skipped',
    step_id: 'sum',
    output_as: 'summary',
    reason: 'no model configured',
  },
  checkpoint_saved: { ...TASK, kind: 'checkpoint_saved', after_step_id: 'open' },
  human_handoff_requested: {
    ...TASK,
    kind: 'human_handoff_requested',
    step_id: 'login',
    reason: 'captcha',
  },
  task_completed: { ...TASK, kind: 'task_completed', outputs_keys: ['price'] },
  task_failed: {
    ...TASK,
    kind: 'task_failed',
    failure_class: 'navigation_timeout',
    report_path: 'report.md',
  },
  validation_failed: {
    ...TASK,
    kind: 'validation_failed',
    path: '/steps/0',
    message: 'unknown verb',
  },
  scope_violation: {
    ...TASK,
    kind: 'scope_violation',
    scope: 'public',
    attempted_verb: 'click',
    step_id: 'buy',
  },
  task_resumed: {
    ...TASK,
    kind: 'task_resumed',
    original_run_id: 'run-0',
    resume_step_id: 'open',
  },
  chrome_drift_warning: {
    ...TASK,
    kind: 'chrome_drift_warning',
    recorded_chrome_major: 128,
    current_chrome_major: 131,
    drift: 3,
  },
  synthesis_completed: {
    ...TASK,
    kind: 'synthesis_completed',
    strategy: 'deterministic',
    sources_in: 5,
    sources_used: 4,
    coverage: 0.8,
    citation_verdict: { claims_checked: 4, flagged: 0, stripped: 0 },
  },
  research_hop_completed: {
    ...TASK,
    kind: 'research_hop_completed',
    hop_index: 1,
    queries: ['q'],
    docs_fetched: 6,
    docs_kept: 4,
    coverage: 0.5,
    coverage_delta: 0.5,
  },
  confirmation_requested: {
    ...TASK,
    kind: 'confirmation_requested',
    request: CONFIRMATION_REQUEST,
  },
  confirmation_resolved: {
    ...TASK,
    kind: 'confirmation_resolved',
    confirmation_id: CONFIRMATION_REQUEST.confirmation_id,
    decision: 'granted',
    decided_by: 'user_interactive',
  },
  discovery_cycle_completed: {
    ...TASK,
    kind: 'discovery_cycle_completed',
    cycle: {
      index: 0,
      started_at: AT,
      ended_at: AT,
      proposed: { verb: 'click', target: 'Next', rationale: 'continue' },
      executed: true,
      result: 'ok',
      observation_digest: 'a'.repeat(64),
    },
  } as unknown as Of<'discovery_cycle_completed'>,
  discovery_session_completed: {
    ...TASK,
    kind: 'discovery_session_completed',
    outcome: 'goal_met',
    cycles: 3,
    promoted_workflow: null,
  },
  recovery: {
    kind: 'recovery',
    rung: 'steer',
    trigger: 'stalled',
    move: 'fill-remaining',
    summary: 'steered to fill the remaining fields',
    at: AT,
  },
  progress: {
    kind: 'progress',
    items: [
      { id: 'fill', kind: 'fill', label: 'Fill the form', state: 'advancing', done: 2, total: 5 },
      {
        id: 'deliverable',
        kind: 'deliverable',
        label: 'Report',
        state: 'pending',
        done: null,
        total: null,
      },
    ],
    summary: '2 of 5 fields filled',
    at: AT,
  },
  assistant_text: { kind: 'assistant_text', text: 'Looking at the form.', at: AT },
  tool_started: { kind: 'tool_started', tool: 'browser_fill', summary: 'fields: email', at: AT },
  tool_finished: {
    kind: 'tool_finished',
    tool: 'browser_fill',
    summary: 'ok',
    status: 'ok',
    durationMs: 120,
    at: AT,
  },
  contract_declared: {
    kind: 'contract_declared',
    revision: 1,
    summary: 'Fill the contact form and take a screenshot',
    at: AT,
  },
  capability_gap: {
    kind: 'capability_gap',
    item: 'artifact:screenshot:viewport',
    reason: 'suppressed_by_flag',
    summary: 'Cannot deliver: viewport screenshot.',
    at: AT,
  },
  goal_echo: {
    kind: 'goal_echo',
    display: 'goal: "find flights"',
    received_chars: 12,
    truncated: false,
    at: AT,
  },
  run_warning: { kind: 'run_warning', source: 'command', text: 'search is slow', at: AT },
  receipt_written: {
    kind: 'receipt_written',
    path: 'execution-receipt.json',
    sha256: 'b'.repeat(64),
    at: AT,
  },
  budget_snapshot: {
    kind: 'budget_snapshot',
    dimensions: [{ name: 'tool_calls', used: 3, limit: 40, unit: 'count' }],
    at: AT,
  },
  artifact_saved: {
    kind: 'artifact_saved',
    path: 'brief.json',
    artifact_kind: 'brief',
    media_type: 'application/json',
    bytes: 1200,
    at: AT,
  },
  intervention_raised: {
    kind: 'intervention_raised',
    intervention_id: CONFIRMATION_REQUEST.confirmation_id,
    intervention_kind: 'confirmation',
    request: CONFIRMATION_REQUEST,
    deadline_at: '2026-11-14T10:03:00.000Z',
    at: AT,
  },
  intervention_resolved: {
    kind: 'intervention_resolved',
    intervention_id: CONFIRMATION_REQUEST.confirmation_id,
    decision: 'granted',
    decided_by: 'user_interactive',
    decided_at: AT,
    at: AT,
  },
  run_outcome: {
    kind: 'run_outcome',
    run_id: 'run-1',
    task_outcome: 'fulfilled',
    termination_reason: 'model_finished',
    stop_detail: null,
    exit_code: 0,
    failure_class: null,
    at: AT,
  },
  search_completed: {
    kind: 'search_completed',
    hop_index: 1,
    provider: 'duckduckgo',
    query: 'quiet laptops',
    result_count: 8,
    cached: false,
    at: AT,
  },
  source_fetched: {
    kind: 'source_fetched',
    hop_index: 1,
    source_index: 1,
    url: 'https://example.test/review',
    status: 'ok',
    failure_class: null,
    duration_ms: 300,
    at: AT,
  },
  extract_completed: { kind: 'extract_completed', hop_index: 1, extracted: 5, failed: 1, at: AT },
  synthesize_started: {
    kind: 'synthesize_started',
    strategy: 'deterministic',
    sources_in: 5,
    at: AT,
  },
  event_omitted: { kind: 'event_omitted', original_kind: 'tool_finished', bytes: 300_000, at: AT },
};

/** `SAMPLE_EVENTS[kind]` with `overrides`. */
export function ev<K extends RunEventKind>(kind: K, overrides: Partial<Of<K>> = {}): Of<K> {
  return { ...SAMPLE_EVENTS[kind], ...overrides };
}

/** Whether `event` parses as a protocol `RunEvent`. */
export function isValidRunEvent(event: unknown): boolean {
  return RunEvent.safeParse(event).success;
}

/** `events` numbered from `from` (default 1). */
export function numbered(
  events: readonly unknown[],
  from = 1,
): { readonly seq: number; readonly event: unknown }[] {
  return events.map((event, index) => ({ seq: from + index, event }));
}
