import type { IntentLocatorChain, LocatorChain, NameMatch } from '@yantra/protocol';
import type { ElementHandle } from 'puppeteer-core';

import { resolveActionable } from '../../locator/auto-wait.js';
import type {
  ActionableRequirement,
  AriaRole,
  EngineLocatorCandidate,
  EngineLocatorChain,
} from '../../locator/types.js';
import type { ExecutionContext } from '../types.js';

/** Result from resolveLocatorChain — discriminated by kind. */
export type LocatorResolutionResult =
  | { readonly kind: 'found'; readonly elementHandle: ElementHandle; readonly chainName: string }
  | {
      readonly kind: 'not_found';
      readonly chainName: string;
      readonly candidatesCount: number;
      /** Why the chain failed, and what it tried — surfaced in the run report. */
      readonly diagnostics: string;
    }
  | { readonly kind: 'error'; readonly error: Error };

const DEFAULT_ACTIONABLE_TIMEOUT_MS = 30_000;

/** Options accepted by {@link resolveLocatorChain}. */
export interface ResolveLocatorOptions {
  /**
   * Conditions the element must meet. Defaults to `actionable`, which is
   * correct only for verbs that synthesize pointer input. Read-only verbs pass
   * `visible` — see {@link ActionableRequirement}.
   */
  readonly requirement?: ActionableRequirement;
  /** Overall deadline for the auto-wait loop. Defaults to 30s. */
  readonly timeoutMs?: number;
}

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
  options: ResolveLocatorOptions = {},
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
      diagnostics: unresolvableChainDiagnostics(locator, ctx),
    };
  }

  if (chain.candidates.length === 0) {
    // Every persisted candidate was empty or unrepresentable. Resolving would
    // walk an empty chain and report a bare "not found", which sends the author
    // looking at the page rather than at the recording that produced this.
    return {
      kind: 'not_found',
      chainName: chain.name,
      candidatesCount: 0,
      diagnostics:
        `Locator "${chain.name}" has no usable candidates — every recorded entry was ` +
        `empty. Re-record the workflow, or author the locator by hand in the _locators block.`,
    };
  }

  try {
    const result = await resolveActionable(chain, ctx.locatorHost, {
      timeoutMs: options.timeoutMs ?? DEFAULT_ACTIONABLE_TIMEOUT_MS,
      requirement: options.requirement ?? 'actionable',
    });
    return { kind: 'found', elementHandle: result.elementHandle, chainName: chain.name };
  } catch (err) {
    // Every "the element was not usable" outcome collapses to `not_found` for
    // the caller, but the diagnostics distinguish them: matched-nothing,
    // matched-too-many, and matched-but-never-actionable have entirely
    // different fixes and were previously indistinguishable in the report.
    if (
      err instanceof Error &&
      (err.name === 'LocatorNotFoundError' ||
        err.name === 'LocatorAmbiguousError' ||
        err.name === 'LocatorNotActionableError')
    ) {
      return {
        kind: 'not_found',
        chainName: chain.name,
        candidatesCount: chain.candidates.length,
        diagnostics: `${err.message} ${describeChain(chain)}`,
      };
    }
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) };
  }
}

/** Renders a chain's candidates so a failure report says what was attempted. */
function describeChain(chain: EngineLocatorChain): string {
  const rendered = chain.candidates.map((c, i) => `[${i}] ${describeIntent(c)}`).join('; ');
  return `Candidates tried: ${rendered}`;
}

function describeIntent(candidate: EngineLocatorCandidate): string {
  const { intent } = candidate;
  switch (intent.kind) {
    case 'role':
      return intent.name === undefined
        ? `role=${intent.role}`
        : `role=${intent.role} name=${renderMatcher(intent.name)}`;
    case 'testid':
      return `testid=${intent.value}`;
    case 'label':
      return `label=${renderMatcher(intent.text)}`;
    case 'placeholder':
      return `placeholder=${renderMatcher(intent.text)}`;
    case 'text':
      return `text=${renderMatcher(intent.text)}`;
    case 'css':
      return `css=${intent.selector}`;
    case 'xpath':
      return `xpath=${intent.expression}`;
    case 'relative':
      return `relative(${intent.relation})`;
  }
}

function renderMatcher(matcher: string | RegExp): string {
  return matcher instanceof RegExp ? `/${matcher.source}/${matcher.flags}` : `"${matcher}"`;
}

/**
 * Explains a chain that could not even be built — a named locator missing from
 * `_locators`, or a `recorded` reference with no recording behind it. Both
 * previously produced the same opaque "locator not found" as a page that had
 * simply changed.
 */
function unresolvableChainDiagnostics(locator: LocatorChain, ctx: ExecutionContext): string {
  if (locator.kind === 'workflow') {
    if (!ctx.workflowLocators) {
      return (
        `Locator "${locator.name}" is a named workflow locator, but this run has no ` +
        `locator table. The plan was not built from a workflow file.`
      );
    }
    return (
      `Named locator "${locator.name}" is not defined in the workflow's _locators block. ` +
      `Check for a typo, or re-record the workflow.`
    );
  }
  if (locator.kind === 'recorded') {
    return (
      `Step references recorded locator index ${locator.step_index}, which this run cannot ` +
      `resolve — recorded locator references are not supported outside a recording session.`
    );
  }
  return `Locator ${locatorName(locator)} could not be compiled into a candidate chain.`;
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
            ? { name: nameMatchToLocatorName(locator.name_match), exact: true }
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
