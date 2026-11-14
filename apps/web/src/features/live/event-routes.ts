/**
 * Where each run event is shown in the cockpit (FEAT-067 TASK-002).
 *
 * Every `RunEvent` kind maps to at least one instrument, and the
 * EventInspector is always a permitted fallback (memory -> General: every
 * protocol event kind maps to an instrument or the generic inspector). A
 * kind this build does not know, sent by a newer worker, goes to the
 * inspector (plan D17). The table is a `Record` over the union, so a new kind
 * without a route fails typecheck; a test also iterates the protocol's
 * runtime union, because test files are not typechecked (memory -> Testing).
 */

import type { RunEventKind } from '@yantra/protocol';

/** The cockpit instrument an event feeds. */
export type InstrumentRoute =
  | 'timeline'
  | 'contract'
  | 'requirements'
  | 'budgets'
  | 'top_bar'
  | 'status'
  | 'outcome'
  | 'inspector';

/** Every known kind and the instruments that show it. */
export const EVENT_ROUTES: Readonly<Record<RunEventKind, readonly InstrumentRoute[]>> = {
  // Workflow task lifecycle (TaskEvent).
  task_queued: ['status'],
  task_started: ['top_bar', 'timeline'],
  step_started: ['timeline'],
  step_retry: ['timeline'],
  step_completed: ['timeline'],
  llm_step_skipped: ['timeline'],
  checkpoint_saved: ['timeline'],
  human_handoff_requested: ['timeline', 'status'],
  task_completed: ['timeline'],
  task_failed: ['timeline'],
  validation_failed: ['timeline'],
  scope_violation: ['timeline'],
  task_resumed: ['timeline'],
  chrome_drift_warning: ['timeline'],
  synthesis_completed: ['timeline'],
  research_hop_completed: ['timeline'],
  confirmation_requested: ['status'],
  confirmation_resolved: ['status'],
  discovery_cycle_completed: ['inspector'],
  discovery_session_completed: ['inspector'],
  // Agent progress.
  recovery: ['timeline', 'status'],
  progress: ['requirements', 'contract'],
  assistant_text: ['inspector'],
  tool_started: ['timeline'],
  tool_finished: ['timeline'],
  contract_declared: ['contract'],
  capability_gap: ['contract'],
  // Run-level facts.
  goal_echo: ['top_bar'],
  run_warning: ['timeline'],
  receipt_written: ['inspector'],
  budget_snapshot: ['budgets'],
  artifact_saved: ['timeline'],
  intervention_raised: ['status'],
  intervention_resolved: ['status'],
  run_outcome: ['outcome', 'status'],
  // Deterministic ask/research phases.
  search_completed: ['timeline', 'contract'],
  source_fetched: ['timeline', 'contract'],
  extract_completed: ['timeline', 'contract'],
  synthesize_started: ['timeline', 'contract'],
  event_omitted: ['inspector'],
};

const INSPECTOR_ONLY: readonly InstrumentRoute[] = Object.freeze(['inspector']);

/** Whether `kind` is a kind this build knows. */
export function isKnownKind(kind: string): kind is RunEventKind {
  return Object.prototype.hasOwnProperty.call(EVENT_ROUTES, kind);
}

/** The routes of `kind`; an unknown kind (a newer worker) goes to the inspector. */
export function routesFor(kind: string): readonly InstrumentRoute[] {
  return isKnownKind(kind) ? EVENT_ROUTES[kind] : INSPECTOR_ONLY;
}

/** Whether `kind` is shown in the EventInspector. */
export function isInspected(kind: string): boolean {
  return routesFor(kind).includes('inspector');
}
