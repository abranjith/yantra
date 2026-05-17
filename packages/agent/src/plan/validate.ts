import type { Plan, ValidationError } from '@yantra/protocol';
import type { SemanticValidationContext } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';
import { validateSemantics } from '@yantra/protocol';

export type { SemanticValidationContext };

/**
 * Runs semantic validation on a plan, adapting the result to a Result type.
 *
 * Delegates to FEAT-002's validateSemantics — this is the single call site
 * for semantic validation within packages/agent.
 */
export function validatePlanSemantics(
  plan: Plan,
  context: SemanticValidationContext = {},
): Result<Plan, ValidationError[]> {
  return validateSemantics(plan, context);
}
