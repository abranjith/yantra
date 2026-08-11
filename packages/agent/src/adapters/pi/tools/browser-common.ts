import {
  BrowserActionabilityError,
  StaleElementRefError,
  type AgentBrowserController,
  type AgentBrowserObservation,
  type AgentInteractable,
  type BrowserActionResult,
  type FillFailure,
  type WidgetPort,
  type WidgetTarget,
} from '@yantra/core';
import type { LocatorCandidate } from '@yantra/protocol';

import type { DomainFailure } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

import { resolveFormField } from './form-field-resolve.js';

/** Internal observation cap used for deterministic field resolution. */
export const FILL_RESOLUTION_CAP = 400;

export function browserController(services: RunServices): AgentBrowserController | DomainFailure {
  const controller = services.domain.browser?.controller;
  return (
    controller ?? {
      ok: false,
      errorCode: 'BROWSER_UNAVAILABLE',
      message: 'Browser services are not configured for this run.',
      retryable: false,
    }
  );
}

/**
 * Narrows any `T | DomainFailure` union to the failure arm.
 *
 * Generic because tools now return domain values other than a controller from
 * the same union (a resolved form field, a per-field outcome); the check itself
 * is unchanged — only a `DomainFailure` carries `ok: false`.
 */
export function isDomainFailure<T>(value: T | DomainFailure): value is DomainFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    (value as { readonly ok: unknown }).ok === false
  );
}

export function browserFailure(error: unknown): DomainFailure {
  if (error instanceof StaleElementRefError || error instanceof BrowserActionabilityError) {
    return { ok: false, errorCode: error.code, message: error.message, retryable: true };
  }
  if (error instanceof Error && error.message.includes('browser_navigate')) {
    return { ok: false, errorCode: 'BROWSER_NOT_STARTED', message: error.message, retryable: true };
  }
  throw error;
}

/** Preserve a core fill failure verbatim at the provider-neutral tool seam. */
export function mapFillFailure(failure: FillFailure): DomainFailure {
  // The next step rides in the message, not only in `details`. A model that
  // sees a bare typed code tends to abandon the tool and operate the widget by
  // hand with browser_click, which is the behaviour these tools exist to
  // replace, so the one actionable sentence has to be somewhere it cannot miss.
  const hint = typeof failure.details.hint === 'string' ? failure.details.hint : null;
  return {
    ok: false,
    errorCode: failure.errorCode,
    message: hint ? `${failure.message} ${hint}` : failure.message,
    retryable: failure.retryable,
    details: failure.details,
  };
}

/** Resolve a visible field name or current eNN ref from a fresh observation. */
export async function resolveFillTarget(
  field: string,
  controller: AgentBrowserController,
  preferred?: WidgetTarget,
): Promise<WidgetTarget | DomainFailure> {
  const observation = await controller.observe({
    cap: FILL_RESOLUTION_CAP,
    trackDigest: false,
  });
  const resolved = resolveFormField(field, observation);
  if (!isDomainFailure(resolved)) return toWidgetTarget(resolved);
  // With `preferred` the caller is re-finding a control it already resolved
  // once, so same-named duplicates are ranked instead of refused. Deciding
  // *which field was meant* stays strict — "Check-in" and "Check-out" share a
  // prefix and picking one would fill the wrong date — but by now that choice
  // is made, and an open picker having mounted a second copy of its own
  // trigger must not strand the retry that exists to recover from it.
  if (!preferred || resolved.errorCode !== 'FORM_FIELD_AMBIGUOUS') return resolved;
  const wanted = preferred.name.trim().toLowerCase();
  const sameName = observation.interactables.filter(
    (entry) => entry.name.trim().toLowerCase() === wanted && entry.role === preferred.role,
  );
  if (sameName.length === 0) return resolved;
  const grouped = sameName.filter((entry) => (entry.group ?? null) === preferred.group);
  return toWidgetTarget((grouped.length > 0 ? grouped : sameName)[0]!);
}

function toWidgetTarget(entry: AgentInteractable): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}

/** Thin core port adapter; action healing belongs to the controller. */
export function browserWidgetPort(
  controller: AgentBrowserController,
  now: () => number,
): WidgetPort {
  return {
    observe: (options) => controller.observe(options),
    click: (ref) => controller.click(ref),
    fill: (ref, value) => controller.fill(ref, value),
    evaluateOn: (ref, fn, ...args) => controller.evaluateOn(ref, fn, ...args),
    evaluate: (fn, ...args) => controller.evaluate(fn, ...args),
    press: (key) => controller.press(key),
    now,
  };
}

export const PROTECTED_ACTION_RE =
  /\b(?:buy|pay|purchase|book|order|submit|confirm|place order)\b/i;

/**
 * Derives the durable locator chain for a ref without ever failing the action.
 *
 * The chain is recorded so a promoted workflow can find the element again; it
 * is not part of doing what the user asked. A controller that cannot supply one
 * — an older or stubbed implementation, a page mid-navigation — must degrade to
 * the caller's fallback, never turn a successful click into a tool error.
 *
 * @param controller - The run's browser controller.
 * @param ref - The opaque ref about to be acted on.
 * @returns The ranked chain, or `[]` when it cannot be derived.
 */
export async function safeLocatorFor(
  controller: AgentBrowserController,
  ref: string,
): Promise<LocatorCandidate[]> {
  if (typeof controller.locatorFor !== 'function') return [];
  try {
    return await controller.locatorFor(ref);
  } catch {
    return [];
  }
}

/**
 * Attest what a completed browser action put in front of the run.
 *
 * Every action result carries URLs the *page itself* produced, and provenance
 * exists to separate those from URLs a model assembled. Two of them:
 *
 * - **Where the action landed.** A click that navigates, or a navigation the
 *   site redirected, arrives somewhere the run reached organically. Returning
 *   to it later must not be refused as a guess.
 * - **An intercepted popup's target.** The single-page policy closes popups and
 *   reports the URL precisely so a later explicit navigation can re-enter it
 *   through URL and ethics policy — that is the documented contract.
 *
 * Only `browser_navigate` used to do this, and popups are opened by *clicks*.
 * So a search button with `target=_blank` produced a `popup_intercepted` URL
 * the agent was then forbidden to visit: runs
 * `20260811T023421Z-do-83684cb3` (Priceline) and
 * `20260811T025845Z-do-963e62f1` (KAYAK) each burned their remaining budget
 * alternating between clicking Search and being refused
 * `URL_NOT_FROM_EVIDENCE` for the URL the tool had just handed them, and both
 * published results for the wrong dates. Recording lives here, at the seam
 * every action result passes through, so no future tool can forget it.
 */
export function recordActionProvenance(
  services: RunServices,
  result: Pick<BrowserActionResult, 'url' | 'popup_intercepted'>,
): void {
  services.urlProvenance.record(result.url);
  if (result.popup_intercepted !== undefined) {
    services.urlProvenance.record(result.popup_intercepted);
  }
}

/** Best-effort fresh read after a successful action. */
export async function observeAfterAction(
  controller: AgentBrowserController,
): Promise<AgentBrowserObservation | undefined> {
  try {
    return await controller.observe();
  } catch {
    return undefined;
  }
}

/** Convert the controller's internal camelCase digest state to the tool shape. */
export function modelObservation(observation: AgentBrowserObservation): {
  readonly url: string;
  readonly title: string;
  readonly digest?: string;
  readonly digest_unchanged?: true;
  readonly interactables: AgentBrowserObservation['interactables'];
} {
  const model: {
    url: string;
    title: string;
    digest?: string;
    digest_unchanged?: true;
    interactables: AgentBrowserObservation['interactables'];
  } = {
    url: observation.url,
    title: observation.title,
    interactables: observation.interactables,
  };
  if (observation.digestUnchanged) model.digest_unchanged = true;
  else if (observation.digest.length > 0) model.digest = observation.digest;
  return model;
}
