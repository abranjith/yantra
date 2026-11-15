import type { ConfirmationBinding, ConfirmationRequest, Plan, Step } from '@yantra/protocol';

import { canonicalJson, sha256Text } from './canonical-digest.js';

/** Binding fields computed for a workflow step confirmation request. */
export interface ComputedConfirmationBinding {
  readonly target_host: string | null;
  readonly plan_digest: string;
  readonly step_digest: string;
}

/**
 * Normalizes a URL or host[:port] string into a lowercase hostname without port.
 * Returns `null` when absent, empty, unparseable, or sentinel `'unknown'` / `'about:blank'`.
 */
export function normalizeTargetHost(rawUrlOrHost: string | null | undefined): string | null {
  if (rawUrlOrHost === null || rawUrlOrHost === undefined) {
    return null;
  }
  const trimmed = rawUrlOrHost.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  try {
    const parsed = trimmed.includes('://')
      ? new URL(trimmed)
      : trimmed.startsWith('about:')
        ? new URL(trimmed)
        : new URL(`http://${trimmed}`);
    const hostname = parsed.hostname.toLowerCase();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
}

/**
 * Computes the workflow action-binding fields (`target_host`, `plan_digest`,
 * `step_digest`) for a `ConfirmationRequest`.
 *
 * `plan_digest` hashes the canonical JSON of the resolved plan stored in `plan.json`
 * (matching what `loadResumePoint` reads). `step_digest` hashes the canonical JSON
 * of the declared step definition — parameter templates stay unresolved and secret
 * refs stay opaque.
 */
export function computeConfirmationBinding(
  plan: Plan,
  step: Step,
  resolvedUrl: string | null | undefined,
): ComputedConfirmationBinding {
  return {
    target_host: normalizeTargetHost(resolvedUrl),
    plan_digest: sha256Text(canonicalJson(plan)),
    step_digest: sha256Text(canonicalJson(step)),
  };
}

/** Extracts the six-field binding tuple from a `ConfirmationRequest`. */
export function bindingOf(request: ConfirmationRequest): ConfirmationBinding {
  return {
    run_id: request.run_id,
    step_id: request.step_id,
    action_kind: request.action_kind,
    target_host: request.target_host ?? null,
    plan_digest: request.plan_digest ?? null,
    step_digest: request.step_digest ?? null,
  };
}

/**
 * Compares two six-field binding tuples for exact equality (plan §2 / D12).
 *
 * A `null` `target_host` on either side always counts as a mismatch.
 * `plan_digest` and `step_digest` must match as non-null strings for workflow
 * requests; only when both sides omit both digests (agentic requests) do
 * null digests match.
 */
export function bindingsMatch(a: ConfirmationBinding, b: ConfirmationBinding): boolean {
  if (a.run_id !== b.run_id) return false;
  if (a.step_id !== b.step_id) return false;
  if (a.action_kind !== b.action_kind) return false;
  if (a.target_host === null || b.target_host === null || a.target_host !== b.target_host) {
    return false;
  }

  const aBothNull = a.plan_digest === null && a.step_digest === null;
  const bBothNull = b.plan_digest === null && b.step_digest === null;
  if (aBothNull && bBothNull) {
    return true;
  }
  if (
    a.plan_digest === null ||
    b.plan_digest === null ||
    a.step_digest === null ||
    b.step_digest === null
  ) {
    return false;
  }
  return a.plan_digest === b.plan_digest && a.step_digest === b.step_digest;
}
