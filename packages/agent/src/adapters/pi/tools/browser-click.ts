import {
  classifyFailure,
  normalizeText,
  resolveInteractable,
  withAttempts,
  type AgentBrowserController,
  type AgentInteractable,
  type BrowserActionResult,
} from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  followSiteOpenedTab,
  isDomainFailure,
  modelObservation,
  observeAfterAction,
  PROTECTED_ACTION_RE,
  recordActionProvenance,
  safeLocatorFor,
} from './browser-common.js';

/**
 * How long one click may spend recovering before it reports what it saw.
 *
 * Re-acquisition is two observations at most; this bounds the pathological
 * case where each one is itself slow, and keeps a click well inside the
 * runtime's per-tool timeout.
 */
const CLICK_RECOVERY_BUDGET_MS = 15_000;

/**
 * Find the element again after the page replaced the node behind its ref.
 *
 * Constrained to the same normalized name AND role the ref described before
 * the click, and refusing anything the shared ladder cannot settle. Recovering
 * an identity is not the same as choosing a different element: a same-named
 * button in a different role is a different control, and clicking it because
 * the intended one vanished would be the tool acting on its own judgement.
 */
async function reacquireClickTarget(
  controller: AgentBrowserController,
  described: AgentInteractable | undefined,
): Promise<AgentInteractable | null> {
  if (!described || described.name.trim().length === 0) return null;
  // Recovery is best-effort by construction: it exists to save a click that
  // would otherwise fail, and must never convert that click's typed failure
  // into an unexpected crash. A read that cannot be taken simply means the
  // element cannot be re-acquired.
  let observation;
  try {
    observation = await controller.observe({ cap: 400, trackDigest: false });
  } catch {
    return null;
  }
  if (!observation || !Array.isArray(observation.interactables)) return null;
  const resolved = resolveInteractable(described.name, observation.interactables, {
    preferred: {
      ref: described.ref,
      role: described.role,
      name: described.name,
      group: described.group ?? null,
      value: described.value ?? null,
    },
  });
  if (resolved.kind !== 'match') return null;
  const sameControl =
    normalizeText(resolved.entry.name) === normalizeText(described.name) &&
    resolved.entry.role === described.role;
  return sameControl ? resolved.entry : null;
}

const BrowserClickParams = Type.Object(
  {
    ref: Type.String({
      pattern: '^e[0-9]+$',
      description: 'Opaque ref from the latest browser_observe result.',
    }),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserClickParams>;

/** Build the opaque-ref click tool with protected-action confirmation. */
export function browserClickSpec(
  services: RunServices,
): ToolWrapperSpec<typeof BrowserClickParams> {
  return {
    name: 'browser_click',
    label: 'Browser Click',
    description:
      'Click one actionable element by its latest opaque observation ref. A fresh post-action observation is returned, so browser_observe is only needed for a read without acting. If the page replaces the element mid-click the tool re-finds it by the same name and role and reports resolved_by plus attempted, so a failure here means that recovery already ran. Do NOT supply CSS/XPath, reuse stale refs, or click protected submit/purchase actions without user confirmation.',
    parameters: BrowserClickParams,
    sanitizationProfile: 'public',
    mutating: true,
    requiresConfirmation: (params: Params) =>
      PROTECTED_ACTION_RE.test(
        services.domain.browser?.controller.describeRef(params.ref)?.name ?? '',
      ),
    buildConfirmation: (params: Params) => ({
      action_kind: 'click',
      host: services.domain.browser?.controller.host() ?? '',
      description: `Click "${services.domain.browser?.controller.describeRef(params.ref)?.name ?? params.ref}".`,
      consequence: 'hard_to_reverse',
    }),
    run: async (params: Params, ctx): Promise<DomainResult> => {
      const controller = browserController(ctx.services);
      if (isDomainFailure(controller)) return controller;
      // Capture the element's role/name, durable locator, and host BEFORE
      // clicking — a click that navigates clears the refs along with the old
      // document, and the locator can only be derived from the live element.
      const described = controller.describeRef(params.ref);
      const host = controller.host();
      const name = described?.name ?? '';

      let activeRef = params.ref;
      let ranked = await safeLocatorFor(controller, activeRef);
      let resolvedBy = 'ref';
      // Set when the element is gone and no same-named replacement exists, so
      // the shared retry stops instead of burning its remaining attempts on a
      // control that is not coming back.
      let recoveryExhausted = false;

      const run = await withAttempts<BrowserActionResult, DomainFailure>(
        async (attempt) => {
          if (attempt > 1) {
            const reacquired = await reacquireClickTarget(controller, described);
            if (!reacquired) {
              recoveryExhausted = true;
              return {
                ok: false,
                failure: {
                  ok: false,
                  errorCode: 'STALE_ELEMENT_REF',
                  message:
                    `Element ref "${params.ref}" is gone and no element with the same name and ` +
                    'role replaced it. Call browser_observe again for current refs.',
                  retryable: true,
                },
              };
            }
            activeRef = reacquired.ref;
            resolvedBy = 're-resolved';
            ranked = await safeLocatorFor(controller, activeRef);
          }
          try {
            return { ok: true, value: await controller.click(activeRef) };
          } catch (error) {
            // `browserFailure` re-throws anything it does not recognise, so an
            // unexpected error still surfaces rather than being retried blindly.
            return { ok: false, failure: browserFailure(error) };
          }
        },
        {
          // One click, then at most two re-acquisitions.
          maxAttempts: 3,
          deadlineMs: ctx.services.now() + CLICK_RECOVERY_BUDGET_MS,
          backoffMs: [0],
          classify: (failure) =>
            recoveryExhausted ? 'terminal' : classifyFailure(failure.errorCode),
          describe: (failure) => ({ errorCode: failure.errorCode }),
          now: () => ctx.services.now(),
          label: (attempt) => (attempt === 1 ? 'click' : 're-resolve-ref'),
        },
      );

      if (!run.outcome.ok) {
        return run.ledger.records.length > 1
          ? { ...run.outcome.failure, details: { attempted: run.ledger.records } }
          : run.outcome.failure;
      }
      const clicked = run.outcome.value;
      // A click is how a page hands the run a new URL — by navigating, or by
      // opening a popup this policy closes and reports. Either way the page
      // produced it, so it is attested. Attesting BEFORE following the tab is
      // what lets the follow re-check it like any other navigation target.
      recordActionProvenance(ctx.services, clicked);
      const result = await followSiteOpenedTab(ctx.services, controller, clicked);
      ctx.services.trace?.append({
        kind: 'click',
        host,
        locator: ranked.length > 0 ? ranked : toCandidateChain(described?.role ?? '', name),
        requires_confirmation: PROTECTED_ACTION_RE.test(name),
      });
      const observation = await observeAfterAction(controller);
      // `popup_followable` is the handshake between the controller and the
      // policy check above; by now it is either followed or refused, and
      // showing the model a second copy of the URL it must not act on twice
      // is how a run ends up navigating away from the tab it just adopted.
      const { popup_followable: _followable, ...model } = result;
      return {
        ok: true,
        model: {
          ...model,
          ...(resolvedBy === 're-resolved' ? { resolved_by: resolvedBy } : {}),
          ...(run.ledger.records.length > 1 ? { attempted: run.ledger.records } : {}),
          ...(observation ? { observation: modelObservation(observation) } : {}),
        },
      };
    },
  };
}
