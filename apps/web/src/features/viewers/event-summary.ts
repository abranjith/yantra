/**
 * One-line summaries of known event kinds in `events.jsonl` (`TaskEvent`)
 * and `run-events.jsonl` (`RunEvent` records) (FEAT-066 TASK-008).
 *
 * Browser code may import protocol types only, so the known kinds are listed
 * here; a test pins every one to the protocol's own kind lists. A kind not
 * listed here, or a line whose fields do not fit, has no summary: the viewer
 * shows it in the EventInspector instead.
 */

type Fields = Readonly<Record<string, unknown>>;

function word(fields: Fields, key: string): string | null {
  const value = fields[key];
  return typeof value === 'string' && value.length > 0 && value.length <= 120 ? value : null;
}

function parts(...items: (string | null)[]): string {
  return items.filter((item): item is string => item !== null).join(' · ');
}

/** Summary builders by event kind; each returns null when the fields do not fit. */
export const EVENT_SUMMARIES: Readonly<Record<string, (fields: Fields) => string | null>> = {
  task_queued: () => 'task queued',
  task_started: () => 'task started',
  task_resumed: () => 'task resumed',
  step_started: (f) => parts('step started', word(f, 'step_id'), word(f, 'scope')),
  step_retry: (f) => parts('step retry', word(f, 'step_id')),
  step_completed: (f) => parts('step completed', word(f, 'step_id')),
  checkpoint_saved: (f) => parts('checkpoint saved', word(f, 'step_id')),
  human_handoff_requested: (f) => parts('handoff requested', word(f, 'step_id'), word(f, 'reason')),
  task_completed: () => 'task completed',
  task_failed: (f) => parts('task failed', word(f, 'failure_class'), word(f, 'task_outcome')),
  validation_failed: (f) => parts('validation failed', word(f, 'path')),
  scope_violation: (f) => parts('scope violation', word(f, 'step_id')),
  tool_started: (f) => parts('tool started', word(f, 'tool')),
  tool_finished: (f) => parts('tool finished', word(f, 'tool'), word(f, 'status')),
  confirmation_requested: () => 'confirmation requested',
  confirmation_resolved: (f) => parts('confirmation resolved', word(f, 'decision')),
  intervention_raised: () => 'intervention raised',
  intervention_resolved: () => 'intervention resolved',
  artifact_saved: (f) => parts('artifact saved', word(f, 'path')),
  receipt_written: () => 'execution receipt written',
  run_warning: () => 'run warning',
  run_outcome: (f) => parts('run outcome', word(f, 'task_outcome'), word(f, 'termination_reason')),
  search_completed: (f) => parts('search completed', word(f, 'provider')),
  source_fetched: (f) => parts('source fetched', word(f, 'status')),
  extract_completed: () => 'extract completed',
  synthesize_started: () => 'synthesis started',
  synthesis_completed: () => 'synthesis completed',
};

/** The event of a parsed line: a run-event record's `event`, or the line itself. */
export function eventOf(value: unknown): Fields | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Fields;
  const inner = record.event;
  if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) return inner as Fields;
  return record;
}

/** The summary of a parsed event line, or null when its kind is unknown or it does not fit. */
export function summarizeEvent(value: unknown): string | null {
  const event = eventOf(value);
  const kind = event === null ? null : word(event, 'kind');
  if (event === null || kind === null) return null;
  const summarize = EVENT_SUMMARIES[kind];
  return summarize === undefined ? null : summarize(event);
}

/** Files whose lines are events the viewer can summarize. */
export const EVENT_FILES: ReadonlySet<string> = new Set(['events.jsonl', 'run-events.jsonl']);
