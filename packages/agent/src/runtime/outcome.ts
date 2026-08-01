import type { AgentError } from '../provider/types.js';

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
 * `saved:false` reports an actionable error while the run still succeeds.
 */
export type PromotionResult =
  | { readonly saved: true; readonly workflowName: string }
  | { readonly saved: false; readonly workflowName: string; readonly error: string };

/** Closed terminal result of exactly one agentic task run. */
export type AgenticTaskOutcome =
  | {
      readonly kind: 'published';
      readonly runId: string;
      readonly runDir: string;
      readonly brief: PublishedBriefRef;
      /** Present when `--save-as` requested workflow promotion. */
      readonly promotion?: PromotionResult;
    }
  | {
      readonly kind: 'handoff';
      readonly runId: string;
      readonly runDir: string;
      readonly blocker: string;
      readonly safestNextAction: string;
    }
  | {
      readonly kind: 'failed';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
    }
  | {
      readonly kind: 'budget_exhausted';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
    }
  | {
      readonly kind: 'aborted';
      readonly runId: string;
      readonly runDir: string;
      readonly error: AgentError;
    };

/**
 * Map an agentic outcome to Yantra's documented CLI exit-code contract.
 *
 * @param outcome Terminal run outcome.
 * @returns 0 success, 4 human handoff, 2 execution failure, or 130 interrupt.
 */
export function exitCodeForAgenticOutcome(outcome: AgenticTaskOutcome): number {
  switch (outcome.kind) {
    case 'published':
      return 0;
    case 'handoff':
      return 4;
    case 'failed':
    case 'budget_exhausted':
      return 2;
    case 'aborted':
      return 130;
  }
}
