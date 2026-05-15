import type { Plan, SecurityScope } from '@yantra/protocol';
import { ALLOWED_VERBS_BY_SCOPE } from '@yantra/protocol';

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
  const readOnlyAllowed = new Set<string>(ALLOWED_VERBS_BY_SCOPE['read-only-data']);
  const violations: ScopeViolationError[] = [];

  for (const step of plan.steps) {
    const effectiveScope: SecurityScope = step.scope ?? plan.default_scope;
    if (effectiveScope === 'read-only-data' && !readOnlyAllowed.has(step.type)) {
      violations.push(
        new ScopeViolationError(
          {
            scope: effectiveScope,
            attemptedVerb: step.type,
            stepId: step.id,
          },
          { ...context, stepId: step.id },
        ),
      );
    }
  }

  return violations;
}

/**
 * Builds the scope chain array parallel to `plan.steps`.
 * Each element is the effective `SecurityScope` for the step at that index.
 */
export function buildScopeChain(plan: Plan): readonly SecurityScope[] {
  return plan.steps.map((step) => step.scope ?? plan.default_scope);
}
