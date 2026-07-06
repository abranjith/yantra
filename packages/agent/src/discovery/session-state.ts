/**
 * Pure discovery session-state reducer (FEAT-020 TASK-002).
 *
 * Holds the append-only cycle history and derives the trimmed context handed
 * to the next `propose()` call. Trimming keeps the last `fullWindow` (default
 * 3) cycles in full detail and collapses everything older into a one-line
 * summary — bounding prompt size as a session runs long. Pure and
 * side-effect-free: the driver loop (TASK-004) owns the real clock, budget
 * accounting, and persistence; this module only reshapes data.
 */

import type { BudgetSnapshot, DiscoveryCycle, DiscoveryObservation } from '@yantra/protocol';

import type { DiscoveryPromptCycle } from './prompts.js';

/** Immutable session state threaded through a discovery run. */
export interface DiscoverySessionState {
  readonly goal: string;
  readonly hostAllowlist: readonly string[];
  readonly cycles: readonly DiscoveryCycle[];
}

/** A zeroed snapshot for a session with no completed cycles yet. */
export const ZERO_BUDGET_SNAPSHOT: BudgetSnapshot = {
  steps_used: 0,
  llm_calls_used: 0,
  wall_clock_ms: 0,
  cost_usd: 0,
};

/** Builds the initial (empty-history) session state. */
export function initDiscoveryState(opts: {
  readonly goal: string;
  readonly hostAllowlist: readonly string[];
}): DiscoverySessionState {
  return { goal: opts.goal, hostAllowlist: opts.hostAllowlist, cycles: [] };
}

/** Appends a completed cycle, returning a new state (does not mutate the input). */
export function appendCycle(
  state: DiscoverySessionState,
  cycle: DiscoveryCycle,
): DiscoverySessionState {
  return { ...state, cycles: [...state.cycles, cycle] };
}

/** The most recent cycle's budget snapshot, or a zeroed one before any cycle runs. */
export function latestBudgetSnapshot(state: DiscoverySessionState): BudgetSnapshot {
  const last = state.cycles[state.cycles.length - 1];
  return last?.budget_after ?? ZERO_BUDGET_SNAPSHOT;
}

/** The most recent cycle's observation, or null before any cycle runs. */
export function latestObservation(state: DiscoverySessionState): DiscoveryObservation | null {
  const last = state.cycles[state.cycles.length - 1];
  return last?.observation ?? null;
}

/** Grows a host allowlist, de-duplicated, preserving original order. */
export function expandAllowlist(
  state: DiscoverySessionState,
  additionalHosts: readonly string[],
): DiscoverySessionState {
  const merged = [...new Set([...state.hostAllowlist, ...additionalHosts])];
  return { ...state, hostAllowlist: merged };
}

const DEFAULT_FULL_WINDOW = 3;

/**
 * Trims cycle history for the prompt: the last `fullWindow` cycles render in
 * full (rationale, steps, observation, interactables); everything older
 * collapses to a one-line summary. Bounds prompt growth across a long session
 * without silently dropping the oldest context.
 *
 * @param state - Current session state.
 * @param fullWindow - How many of the most recent cycles stay full detail.
 */
export function trimHistoryForPrompt(
  state: DiscoverySessionState,
  fullWindow: number = DEFAULT_FULL_WINDOW,
): readonly DiscoveryPromptCycle[] {
  const total = state.cycles.length;
  const splitAt = Math.max(0, total - fullWindow);

  const oneLine: DiscoveryPromptCycle[] = state.cycles.slice(0, splitAt).map((cycle) => ({
    kind: 'one_line' as const,
    index: cycle.index,
    summary: oneLineSummary(cycle),
  }));

  const full: DiscoveryPromptCycle[] = state.cycles.slice(splitAt).map((cycle) => ({
    kind: 'full' as const,
    index: cycle.index,
    rationale: cycle.proposal.rationale,
    stepsDescription: describeSteps(cycle),
    observationDigest: cycle.observation?.page_digest ?? null,
    interactablesDescription: describeInteractables(cycle.observation),
    stepOutcome: cycle.observation?.step_outcome ?? cycle.validation.verdict,
  }));

  return [...oneLine, ...full];
}

function oneLineSummary(cycle: DiscoveryCycle): string {
  const verbs = cycle.proposal.steps.map((step) => step.type).join('+');
  const outcome = cycle.observation?.step_outcome ?? cycle.validation.verdict;
  const url = cycle.observation?.url ?? '(no observation)';
  return `${verbs} -> ${outcome} @ ${url}`;
}

function describeSteps(cycle: DiscoveryCycle): string {
  return cycle.proposal.steps
    .map((step) => {
      if (step.type === 'navigate') return `navigate`;
      if ('locator' in step && step.locator.kind === 'intent') {
        const name =
          step.locator.name_match?.kind === 'exact' ? step.locator.name_match.value : null;
        return `${step.type}(${step.locator.role}${name ? ` "${name}"` : ''})`;
      }
      return step.type;
    })
    .join(', ');
}

function describeInteractables(observation: DiscoveryObservation | null): string {
  if (observation === null || observation.interactables.length === 0) {
    return '(none)';
  }
  return observation.interactables
    .map(
      (i) => `${i.role}${i.name !== null ? ` "${i.name}"` : ''}${i.disabled ? ' [disabled]' : ''}`,
    )
    .join(', ');
}
