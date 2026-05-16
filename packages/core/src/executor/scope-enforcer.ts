import type { Plan, SecurityScope, StepVerb } from '@yantra/protocol';

import {
  buildScopeChain as buildSecurityScopeChain,
  validateScopeViolations,
} from '../secrets/scope-enforcer.js';

import { ScopeViolationError } from './errors.js';

/**
 * Defense-in-depth scope enforcement at execution start.
 *
 * The semantic validator in `packages/protocol` already rejects mutating
 * verbs in `read-only-data` scope at plan-validation time. This function
 * is the second gate — it runs before any browser action and aborts early
 * with a `ScopeViolationError` on any remaining violation.
 *
 * @returns An array of violations found. Empty means the plan is clean.
 */
export function checkScopeViolations(
  plan: Plan,
  context: { taskId: string; runId: string },
): ScopeViolationError[] {
  return validateScopeViolations(plan).map(
    (violation) =>
      new ScopeViolationError(
        {
          scope: violation.declaredScope,
          attemptedVerb: violation.stepType as StepVerb,
          stepId: violation.stepId,
        },
        { ...context, stepId: violation.stepId },
      ),
  );
}

/**
 * Builds the scope chain array parallel to `plan.steps`.
 * Each element is the effective `SecurityScope` for the step at that index.
 */
export function buildScopeChain(plan: Plan): readonly SecurityScope[] {
  return buildSecurityScopeChain(plan);
}
