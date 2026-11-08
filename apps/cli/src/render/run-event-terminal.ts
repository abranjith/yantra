/**
 * Terminal projection of the run-event union (FEAT-063).
 *
 * Every `RunEvent` kind maps here explicitly: either to the exact bytes the
 * CLI has always printed for it, or to no output. The strings are the ones
 * `CLIConnectorIO.emitAgentEvent`, the goal echo and the `warning:` advisories
 * printed before the union existed; the live-output goldens pin them.
 */

import type { RunEventKind, RunEventType } from '@yantra/protocol';

import { stripControlCharacters } from './goal-echo.js';

/** Where the terminal projection writes. */
export interface TerminalRunEventSinks {
  readonly stream: Pick<NodeJS.WritableStream, 'write'>;
  readonly errStream: Pick<NodeJS.WritableStream, 'write'>;
}

/** The kinds that print anything in a terminal; every other kind is silent. */
export const TERMINAL_PRINTING_KINDS: readonly RunEventKind[] = [
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

/** Renders one run event to the terminal (or nothing, for a non-printing kind). */
export function renderRunEventTerminal(event: RunEventType, sinks: TerminalRunEventSinks): void {
  switch (event.kind) {
    case 'goal_echo':
      sinks.errStream.write(`${event.display}\n`);
      return;
    case 'run_warning':
      sinks.errStream.write(`warning: ${event.text}\n`);
      return;
    case 'assistant_text':
      sinks.stream.write(event.text);
      return;
    case 'tool_started':
      sinks.stream.write(`\n[${event.tool}] ${event.summary}\n`);
      return;
    case 'tool_finished':
      sinks.stream.write(
        `[${event.tool}] ${event.status} — ${event.summary}` +
          `${event.durationMs === null ? '' : ` (${event.durationMs}ms)`}\n`,
      );
      return;
    case 'contract_declared':
      // What the run understood, beside the goal echo on stderr, so a
      // misreading is visible in the first seconds. Control characters are
      // stripped again here: the terminal is the last boundary.
      sinks.errStream.write(
        `${event.revision === 1 ? 'understood' : 'understood (revised)'}: ` +
          `${stripControlCharacters(event.summary)}\n`,
      );
      return;
    case 'progress':
    case 'recovery':
      sinks.errStream.write(`${event.kind}: ${stripControlCharacters(event.summary)}\n`);
      return;
    case 'capability_gap':
      // FEAT-058: a declared item the run cannot deliver, disclosed right
      // after the echo above, in ASCII punctuation; the run keeps going.
      sinks.errStream.write(`${stripControlCharacters(event.summary)}\n`);
      return;
    // Recorded, not printed: task lifecycle, phases, budgets, artifacts,
    // interventions (the consent card is the gateway's own prompt), the
    // receipt and the outcome (the command prints its own result lines).
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

/** Compile-time exhaustiveness: a new kind fails here until it is mapped. */
export function assertNever(value: never): never {
  throw new Error(`Unmapped run event kind: ${String((value as { kind?: unknown }).kind)}`);
}
