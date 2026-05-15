import type { LoopStep } from '@yantra/protocol';

import type { ExecutionContext, StepHandler, StepResult } from '../types.js';

/** Absolute maximum iterations enforced at protocol level (plan §7 invariant). */
const PROTOCOL_MAX_LOOP_ITERATIONS = 1000;

/**
 * Loop step handler.
 *
 * Resolves the `over` collection (CaptureRef or ParamRef), then executes
 * the body step IDs inline in the current context for each iteration up to
 * `min(collection.length, step.max_iterations, PROTOCOL_MAX_LOOP_ITERATIONS)`.
 *
 * Each iteration sets the loop variable (`step.as`) in the capture store
 * so body steps can reference it via CaptureRef. The loop variable is named
 * after `step.as` and is set to the current item.
 */
export const handleLoop: StepHandler<LoopStep> = async (step, ctx): Promise<StepResult> => {
  const collection = resolveCollection(step.over, ctx);

  if (!Array.isArray(collection)) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error(
        `Loop step "${step.id}": "over" resolved to a non-array value (${typeof collection}).`,
      ),
    };
  }

  const cap = Math.min(collection.length, step.max_iterations, PROTOCOL_MAX_LOOP_ITERATIONS);

  if (collection.length > PROTOCOL_MAX_LOOP_ITERATIONS) {
    return {
      kind: 'failed',
      failureClass: 'budget_exhausted',
      error: new Error(
        `Loop step "${step.id}": collection length ${collection.length} exceeds PROTOCOL_MAX_LOOP_ITERATIONS (${PROTOCOL_MAX_LOOP_ITERATIONS}).`,
      ),
    };
  }

  // Build an index for fast step ID → step lookup
  const stepIdxMap = new Map<string, number>();
  for (let i = 0; i < ctx.plan.steps.length; i++) {
    stepIdxMap.set(ctx.plan.steps[i]!.id, i);
  }

  // Validate body step IDs exist
  for (const bodyStepId of step.body_step_ids) {
    if (!stepIdxMap.has(bodyStepId)) {
      return {
        kind: 'failed',
        failureClass: 'validation_error' as import('@yantra/protocol').FailureClass,
        error: new Error(
          `Loop step "${step.id}": body step ID "${bodyStepId}" not found in plan.`,
        ),
      };
    }
  }

  for (let i = 0; i < cap; i++) {
    // Set loop variable
    ctx.captures.set(step.as, collection[i]);

    // Execute each body step
    for (const bodyStepId of step.body_step_ids) {
      const bodyStepIdx = stepIdxMap.get(bodyStepId);
      if (bodyStepIdx === undefined) continue;
      const bodyStep = ctx.plan.steps[bodyStepIdx];
      if (!bodyStep) continue;

      // Dispatch directly — import the dispatch map lazily to avoid circular imports
      const { STEP_DISPATCH } = await import('./index.js');
      const handler = STEP_DISPATCH.get(bodyStep.type);
      if (!handler) {
        return {
          kind: 'failed',
          failureClass: 'unexpected',
          error: new Error(`No handler for step type "${bodyStep.type}" in loop body.`),
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await handler(bodyStep as any, ctx);
      if (result.kind !== 'completed') {
        return result; // Propagate failure/handoff/jump out of loop
      }
    }
  }

  return { kind: 'completed' };
};

function resolveCollection(
  over: LoopStep['over'],
  ctx: ExecutionContext,
): unknown {
  if (over.kind === 'capture') {
    const raw = ctx.captures.get(over.step_id);
    if (raw === undefined) {
      throw new Error(`Loop: capture step "${over.step_id}" not found.`);
    }
    if (over.field !== null) {
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`Loop: capture "${over.step_id}" is not an object.`);
      }
      return (raw as Record<string, unknown>)[over.field];
    }
    return raw;
  }

  if (over.kind === 'param') {
    // Params not wired in FEAT-005 — return empty
    return [];
  }

  return [];
}
