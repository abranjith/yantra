import type { HostBoundSecretRef, Plan, SecurityScope, Step } from '@yantra/protocol';

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

/** Refuses a website secret unless its trusted binding matches the live host. */
export function assertHostBinding(secretRef: HostBoundSecretRef, liveHost: string): void {
  const normalizedLive = normalizeHost(liveHost);
  const allowed = secretRef.hosts.some((binding) => {
    const normalizedBinding = normalizeHost(binding);
    return (
      normalizedBinding === normalizedLive ||
      registrableDomain(normalizedBinding) === registrableDomain(normalizedLive)
    );
  });
  if (!allowed) {
    throw new SecretHostMismatchError(secretRef.key, normalizedLive);
  }
}

/** Typed structural refusal for wrong-host browser fills. */
export class SecretHostMismatchError extends Error {
  public readonly code = 'SECRET_HOST_MISMATCH' as const;
  public constructor(
    public readonly secretKey: string,
    public readonly liveHost: string,
  ) {
    super(`Secret "${secretKey}" is not permitted for host "${liveHost}".`);
    this.name = 'SecretHostMismatchError';
  }
}

function normalizeHost(host: string): string {
  const candidate = host.includes('://') ? host : `https://${host}`;
  try {
    return new URL(candidate).hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch {
    return host.toLowerCase().replace(/^\.+|\.+$/g, '');
  }
}

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.jp',
  'co.nz',
  'com.br',
  'com.mx',
]);

function registrableDomain(host: string): string {
  if (host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const suffix2 = labels.slice(-2).join('.');
  return labels.slice(TWO_LEVEL_PUBLIC_SUFFIXES.has(suffix2) ? -3 : -2).join('.');
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
