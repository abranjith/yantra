import type { Plan, SecurityScope, Step } from '@yantra/protocol';

import { ScopeViolationError, type ScopeViolation } from './errors.js';

const READ_ONLY_ALLOWED_STEPS = new Set<Step['type']>(['extract', 'wait_for', 'llm_summarize']);

export interface ScopeEnforcer {
  validate(plan: Plan): readonly ScopeViolation[];
}

/**
 * Validates scope rules before execution begins.
 */
export class DefaultScopeEnforcer implements ScopeEnforcer {
  public validate(plan: Plan): readonly ScopeViolation[] {
    const violations: ScopeViolation[] = [];
    let previousHost: string | null = null;

    for (const step of plan.steps) {
      const effectiveScope = step.scope ?? plan.default_scope;

      if (effectiveScope === 'read-only-data') {
        if (!READ_ONLY_ALLOWED_STEPS.has(step.type)) {
          const allowed = [...READ_ONLY_ALLOWED_STEPS].join(', ');

          let reason = `Step type "${step.type}" is not allowed in read-only-data scope. Allowed: ${allowed}.`;
          if (step.type === 'navigate') {
            const currentHost = extractHostFromNavigateStep(step);
            if (currentHost && previousHost && currentHost !== previousHost) {
              reason += ` Host changed from ${previousHost} to ${currentHost}.`;
            }
          }

          if (step.type === 'assert' && hasSideEffect(step)) {
            reason += ' Assert step is marked sideEffect=true.';
          }

          violations.push({
            stepId: step.id,
            stepType: step.type,
            declaredScope: effectiveScope,
            reason,
          });
        } else if (step.type === 'navigate') {
          const currentHost = extractHostFromNavigateStep(step);
          if (currentHost && previousHost && currentHost !== previousHost) {
            violations.push({
              stepId: step.id,
              stepType: step.type,
              declaredScope: effectiveScope,
              reason: `Navigate host changed from ${previousHost} to ${currentHost} in read-only-data scope.`,
            });
          }
        }
      }

      if (step.type === 'navigate') {
        previousHost = extractHostFromNavigateStep(step) ?? previousHost;
      }
    }

    return violations;
  }
}

/**
 * Thin helper used by execution gates.
 */
export function enforce(plan: Plan): void {
  const enforcer = new DefaultScopeEnforcer();
  const violations = enforcer.validate(plan);
  if (violations.length > 0) {
    throw new ScopeViolationError(violations);
  }
}

/**
 * Build a scope chain aligned to plan step order.
 */
export function buildScopeChain(plan: Plan): readonly SecurityScope[] {
  return plan.steps.map((step) => step.scope ?? plan.default_scope);
}

/**
 * Validates scope rules and returns all violation details.
 */
export function validateScopeViolations(plan: Plan): readonly ScopeViolation[] {
  return new DefaultScopeEnforcer().validate(plan);
}

function hasSideEffect(step: Step): boolean {
  if (typeof step !== 'object' || step?.type !== 'assert') {
    return false;
  }

  return Boolean((step as { sideEffect?: unknown }).sideEffect);
}

function extractHostFromNavigateStep(step: Step): string | null {
  if (step.type !== 'navigate') {
    return null;
  }

  if (step.url.kind === 'literal' && typeof step.url.value === 'string') {
    return tryReadHost(step.url.value);
  }

  if (step.url.kind === 'template') {
    const staticTemplate = step.url.template.replace(/\{\{\s*[^}]+\s*\}\}/g, '');
    return tryReadHost(staticTemplate);
  }

  return null;
}

function tryReadHost(urlLike: string): string | null {
  try {
    return new URL(urlLike).hostname;
  } catch {
    return null;
  }
}
