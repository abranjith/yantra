/**
 * `--json` projection of the run-event union (FEAT-063).
 *
 * Machine output on stdout is unchanged: only agent progress kinds print, as
 * the `agent_progress` NDJSON lines `do --json` has always written, with the
 * connector-shaped event verbatim. Two human lines that `--json` runs have
 * always written to **stderr** keep doing so: the goal echo and a command's
 * own `warning:` advisories. An agent's advisory is suppressed in `--json`, as
 * before. Every other kind prints nothing.
 */

import {
  SCHEMA_VERSION,
  toAgentProgressEvent,
  type RunEventKind,
  type RunEventType,
} from '@yantra/protocol';

import { assertNever } from './run-event-terminal.js';

/** Where the JSON projection writes. */
export interface JsonRunEventSinks {
  /** Writes one NDJSON line to stdout. */
  jsonLine(value: unknown): void;
  readonly errStream: Pick<NodeJS.WritableStream, 'write'>;
}

/** The kinds that print anything under `--json`. */
export const JSON_PRINTING_KINDS: readonly RunEventKind[] = [
  'goal_echo',
  'run_warning',
  'assistant_text',
  'tool_started',
  'tool_finished',
  'contract_declared',
  'progress',
  'recovery',
  'capability_gap',
];

/** Renders one run event for `--json` (or nothing, for a non-printing kind). */
export function renderRunEventJson(event: RunEventType, sinks: JsonRunEventSinks): void {
  switch (event.kind) {
    case 'goal_echo':
      sinks.errStream.write(`${event.display}\n`);
      return;
    case 'run_warning':
      if (event.source === 'command') sinks.errStream.write(`warning: ${event.text}\n`);
      return;
    case 'assistant_text':
    case 'tool_started':
    case 'tool_finished':
    case 'contract_declared':
    case 'progress':
    case 'recovery':
    case 'capability_gap':
      sinks.jsonLine({
        schemaVersion: SCHEMA_VERSION,
        kind: 'agent_progress',
        event: toAgentProgressEvent(event),
      });
      return;
    case 'task_queued':
    case 'task_started':
    case 'step_started':
    case 'step_retry':
    case 'step_completed':
    case 'llm_step_skipped':
    case 'checkpoint_saved':
    case 'human_handoff_requested':
    case 'task_completed':
    case 'task_failed':
    case 'validation_failed':
    case 'scope_violation':
    case 'task_resumed':
    case 'chrome_drift_warning':
    case 'synthesis_completed':
    case 'research_hop_completed':
    case 'confirmation_requested':
    case 'confirmation_resolved':
    case 'discovery_cycle_completed':
    case 'discovery_session_completed':
    case 'receipt_written':
    case 'budget_snapshot':
    case 'artifact_saved':
    case 'intervention_raised':
    case 'intervention_resolved':
    case 'run_outcome':
    case 'search_completed':
    case 'source_fetched':
    case 'extract_completed':
    case 'synthesize_started':
    case 'event_omitted':
      return;
    default:
      assertNever(event);
  }
}
