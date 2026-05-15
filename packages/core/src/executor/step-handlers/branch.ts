import type { BranchStep } from '@yantra/protocol';

import type { StepHandler, StepResult } from '../types.js';

/**
 * Branch step handler.
 *
 * Evaluates a `BranchCondition` (always or capture_exists) and returns a
 * `jump` result pointing the executor to the correct target step ID.
 * The executor loop handles the actual cursor move.
 */
export const handleBranch: StepHandler<BranchStep> = async (step, ctx): Promise<StepResult> => {
  const condition = step.condition;

  let branchTaken: boolean;

  if (condition.kind === 'always') {
    branchTaken = true;
  } else if (condition.kind === 'capture_exists') {
    const captureRef = condition.capture;
    branchTaken = ctx.captures.has(captureRef.step_id) &&
      (captureRef.field === null || isCaptureFieldPresent(ctx.captures.get(captureRef.step_id), captureRef.field));
  } else {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error(`Unknown branch condition kind: ${(condition as { kind: string }).kind}`),
    };
  }

  if (branchTaken) {
    return { kind: 'jump', toStepId: step.then_step_id };
  }

  if (step.else_step_id !== null) {
    return { kind: 'jump', toStepId: step.else_step_id };
  }

  // No else branch — continue to the next step in the plan
  return { kind: 'completed' };
};

function isCaptureFieldPresent(capture: unknown, field: string): boolean {
  if (typeof capture !== 'object' || capture === null) return false;
  return field in (capture as Record<string, unknown>);
}
