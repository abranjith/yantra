import type { IntentLocatorChain, LocatorChain, NameMatch } from '@yantra/protocol';
import type { ElementHandle } from 'puppeteer-core';

import { resolveActionable } from '../../locator/auto-wait.js';
import type { AriaRole, EngineLocatorCandidate, EngineLocatorChain } from '../../locator/types.js';
import type { ExecutionContext } from '../types.js';

/** Result from resolveLocatorChain — discriminated by kind. */
export type LocatorResolutionResult =
  | { readonly kind: 'found'; readonly elementHandle: ElementHandle; readonly chainName: string }
  | { readonly kind: 'not_found'; readonly chainName: string; readonly candidatesCount: number }
  | { readonly kind: 'error'; readonly error: Error };

const DEFAULT_ACTIONABLE_TIMEOUT_MS = 30_000;

/**
 * Converts a protocol `LocatorChain` to an `EngineLocatorChain` and resolves it
 * via the FEAT-004 auto-wait loop.
 *
 * - `kind: 'intent'` — wraps the intent in a single-candidate chain.
 * - `kind: 'workflow'` — looks up in `ctx.workflowLocators`.
 * - `kind: 'recorded'` — looks up by index in `ctx.workflowLocators` (stub: fails gracefully).
 */
export async function resolveLocatorChain(
  locator: LocatorChain,
  stepId: string,
  ctx: ExecutionContext,
): Promise<LocatorResolutionResult> {
  if (!ctx.locatorHost) {
    return {
      kind: 'error',
      error: new Error(`Step "${stepId}": InjectedScriptHost is not available.`),
    };
  }

  const chain = buildEngineChain(locator, stepId, ctx);
  if (!chain) {
    return {
      kind: 'not_found',
      chainName: locatorName(locator),
      candidatesCount: 0,
    };
  }

  try {
    const result = await resolveActionable(chain, ctx.locatorHost, {
      timeoutMs: DEFAULT_ACTIONABLE_TIMEOUT_MS,
    });
    return { kind: 'found', elementHandle: result.elementHandle, chainName: chain.name };
  } catch (err) {
    if (err instanceof Error && err.name === 'LocatorNotFoundError') {
      return { kind: 'not_found', chainName: chain.name, candidatesCount: chain.candidates.length };
    }
    if (err instanceof Error && err.name === 'LocatorNotActionableError') {
      return { kind: 'not_found', chainName: chain.name, candidatesCount: chain.candidates.length };
    }
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

function buildEngineChain(
  locator: LocatorChain,
  stepId: string,
  ctx: ExecutionContext,
): EngineLocatorChain | null {
  if (locator.kind === 'intent') {
    const candidates: EngineLocatorCandidate[] = [
      {
        intent: {
          kind: 'role',
          role: locator.role as AriaRole,
          ...(locator.name_match !== null
            ? { name: nameMatchToLocatorName(locator.name_match) }
            : {}),
        },
        source: 'authored',
      },
    ];
    return { name: intentDisplayName(locator), candidates, strict: true };
  }

  if (locator.kind === 'workflow') {
    if (!ctx.workflowLocators) {
      return null;
    }
    return ctx.workflowLocators.resolve(locator.name);
  }

  // 'recorded' kind requires FEAT-010 workflow context
  return null;
}

function nameMatchToLocatorName(match: NameMatch): string | RegExp {
  if (match.kind === 'exact') return match.value;
  return new RegExp(match.pattern, match.flags);
}

function intentDisplayName(locator: IntentLocatorChain): string {
  const rolePart = locator.role;
  const namePart =
    locator.name_match !== null
      ? locator.name_match.kind === 'exact'
        ? ` "${locator.name_match.value}"`
        : ` /${locator.name_match.pattern}/`
      : '';
  return `${rolePart}${namePart}`;
}

function locatorName(locator: LocatorChain): string {
  if (locator.kind === 'intent') return intentDisplayName(locator);
  if (locator.kind === 'workflow') return locator.name;
  return `recorded[${locator.step_index}]`;
}
