import type { FailureClass, TaskOutcome, TerminationReason } from '@yantra/protocol';

import type { AgentError } from '../provider/types.js';

import { unmetPhrase } from './fulfillment.js';

/** Stable reference to the validated Brief created by `result_publish`. */
export interface PublishedBriefRef {
  readonly kind: 'brief' | 'templated_report';
  readonly briefId: string;
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly htmlPath: string;
}

/**
 * Result of a `--save-as` workflow promotion attempt. Present on a published
 * outcome only when promotion was requested. Promotion never fails the run —
 * `saved:false` reports an actionable error while the run keeps its outcome.
 */
export type PromotionResult =
  | {
      readonly saved: true;
      readonly workflowName: string;
      /** Labels of fulfilled items no workflow step can replay, saved without them. */
      readonly omitted: readonly string[];
      readonly notes?: readonly string[];
    }
  | { readonly saved: false; readonly workflowName: string; readonly error: string };

/** One unmet requirement, as the terminal line and the CLI report it. */
export interface UnmetRequirement {
  readonly id: string;
  readonly label: string;
  readonly reason: string | null;
}

/** How a `do` publication fared against its contract, item by item. */
export interface RequirementsSummary {
  readonly met: number;
  readonly total: number;
  readonly unmet: readonly UnmetRequirement[];
  /** The met items, by id and label (promotion names the ones it cannot replay). */
  readonly satisfied: readonly { readonly id: string; readonly label: string }[];
  /** False when the run published without declaring a contract. */
  readonly contractDeclared: boolean;
}

/** Closed terminal result of exactly one agentic task run. */
export type AgenticTaskOutcome =
  | {
      readonly kind: 'published';
      readonly runId: string;
      readonly runDir: string;
      readonly brief: PublishedBriefRef;
      /** Whether the task was done: every declared requirement met, or not. */
      readonly taskOutcome: 'fulfilled' | 'partial';
      /** The per-item summary for `do`; null for `ask` and `research`. */
      readonly requirements: RequirementsSummary | null;
      readonly terminationReason: TerminationReason;
      /** Present when `--save-as` requested workflow promotion. */
      readonly promotion?: PromotionResult;
    }
  | {
      readonly kind: 'handoff';
      readonly runId: string;
      readonly runDir: string;
      readonly blocker: string;
      readonly safestNextAction: string;
      readonly terminationReason: TerminationReason;
    }
  | {
      readonly kind: 'failed';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
      readonly terminationReason: TerminationReason;
    }
  | {
      readonly kind: 'budget_exhausted';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
      readonly terminationReason: TerminationReason;
    }
  | {
      readonly kind: 'aborted';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
      readonly terminationReason: TerminationReason;
    };

/** What one task outcome means for every consumer. */
export interface TaskOutcomeMapping {
  /** The documented CLI exit code. */
  readonly exitCode: number;
  /** The manifest `status`. */
  readonly manifestStatus: 'completed' | 'failed' | 'aborted';
  /** The terminal `events.jsonl` event. */
  readonly event: 'task_completed' | 'task_failed';
}

/**
 * The one mapping from task outcome to exit code, manifest status, and event
 * (FEAT-054 D3). Every consumer reads it; none keeps its own copy.
 */
export const TASK_OUTCOME_TABLE: Readonly<Record<TaskOutcome, TaskOutcomeMapping>> = {
  fulfilled: { exitCode: 0, manifestStatus: 'completed', event: 'task_completed' },
  partial: { exitCode: 2, manifestStatus: 'failed', event: 'task_failed' },
  handoff: { exitCode: 4, manifestStatus: 'failed', event: 'task_failed' },
  failed: { exitCode: 2, manifestStatus: 'failed', event: 'task_failed' },
  aborted: { exitCode: 130, manifestStatus: 'aborted', event: 'task_failed' },
};

/** Termination reasons that mean a run budget ended the work. */
const BUDGET_TERMINATIONS: ReadonlySet<TerminationReason> = new Set<TerminationReason>([
  'wall-clock-soft',
  'wall-clock-hard',
  'provider-tokens',
  'tool-budget',
]);

/**
 * The task-outcome word for a terminal outcome.
 *
 * @param outcome Terminal run outcome.
 */
export function taskOutcomeOf(outcome: AgenticTaskOutcome): TaskOutcome {
  switch (outcome.kind) {
    case 'published':
      return outcome.taskOutcome;
    case 'handoff':
      return 'handoff';
    case 'failed':
    case 'budget_exhausted':
      return 'failed';
    case 'aborted':
      return 'aborted';
  }
}

/**
 * The manifest and event failure class for a terminal outcome, or undefined
 * for a fulfilled run.
 *
 * A partial run is classed by why it stopped: a budget termination is
 * `budget_exhausted`, anything else is `requirements_unmet`. A handoff is
 * classed by its blocker.
 */
export function failureClassFor(outcome: AgenticTaskOutcome): FailureClass | undefined {
  switch (outcome.kind) {
    case 'published':
      if (outcome.taskOutcome === 'fulfilled') return undefined;
      return BUDGET_TERMINATIONS.has(outcome.terminationReason)
        ? 'budget_exhausted'
        : 'requirements_unmet';
    case 'handoff':
      return handoffClass(outcome.blocker);
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'aborted':
      return 'user_aborted';
    case 'failed':
      // A missing/unvalidated publication is a validation-contract failure,
      // not an unexpected crash: keep manifest/events consistent with the
      // AGENT_COMPLETION_MISSING code report.md already shows.
      return outcome.error.code === 'AGENT_COMPLETION_MISSING' ? 'validation_error' : 'unexpected';
  }
}

/** A handoff's failure class, read from the blocker the run reported. */
function handoffClass(blocker: string): FailureClass {
  if (/captcha|human verification|verify you are human/iu.test(blocker)) return 'captcha_detected';
  if (/\bmfa\b|multi-factor|two-factor|\b2fa\b|one-time (?:code|password)/iu.test(blocker)) {
    return 'mfa_required';
  }
  return 'unexpected';
}

/**
 * Map an agentic outcome to Yantra's documented CLI exit-code contract,
 * through {@link TASK_OUTCOME_TABLE}.
 *
 * @param outcome Terminal run outcome.
 * @returns 0 fulfilled, 2 partial or failed, 4 human handoff, or 130 interrupt.
 */
export function exitCodeForAgenticOutcome(outcome: AgenticTaskOutcome): number {
  return TASK_OUTCOME_TABLE[taskOutcomeOf(outcome)].exitCode;
}

/** Longest first line before the artifact path. */
const FIRST_LINE_MAX = 240;

/** Unmet items named on the first line before `+N more`. */
const FIRST_LINE_ITEMS = 2;

/**
 * The terminal's first line for a published outcome: the outcome word, the
 * requirement count, at most two unmet items, and the artifact path. Pure and
 * bounded to {@link FIRST_LINE_MAX} characters plus the path.
 *
 * - `Fulfilled: 3 of 3 requirements met. Brief: <path>`
 * - `Partial: 1 of 3 requirements met; viewport screenshot not captured; fields 10 of 48 filled. Brief: <path>`
 * - `Partial: no task contract was declared. Brief: <path>`
 * - `Fulfilled. Brief: <path>` for `ask` and `research`.
 *
 * A templated run says `report` instead of `Brief`.
 *
 * @param path The artifact path to name; defaults to the absolute HTML path.
 */
export function outcomeFirstLine(
  outcome: Extract<AgenticTaskOutcome, { kind: 'published' }>,
  path: string = outcome.brief.htmlPath,
): string {
  const artifact = outcome.brief.kind === 'templated_report' ? 'report' : 'Brief';
  return `${outcomeSummary(outcome)}. ${artifact}: ${path}`;
}

/** The first line without its artifact path, bounded to {@link FIRST_LINE_MAX}. */
export function outcomeSummary(
  outcome: Extract<AgenticTaskOutcome, { kind: 'published' }>,
): string {
  const word = outcome.taskOutcome === 'fulfilled' ? 'Fulfilled' : 'Partial';
  const requirements = outcome.requirements;
  let body: string;
  if (requirements === null) {
    body = word;
  } else if (!requirements.contractDeclared) {
    body = `${word}: no task contract was declared`;
  } else {
    const count = `${requirements.met} of ${requirements.total} requirements met`;
    const named = requirements.unmet.slice(0, FIRST_LINE_ITEMS).map(unmetPhrase);
    const more = requirements.unmet.length - named.length;
    body = [`${word}: ${count}`, ...named, ...(more > 0 ? [`+${more} more`] : [])].join('; ');
  }
  return body.length <= FIRST_LINE_MAX ? body : `${body.slice(0, FIRST_LINE_MAX - 1)}…`;
}
