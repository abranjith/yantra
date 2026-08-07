import {
  BrowserActionabilityError,
  StaleElementRefError,
  type AgentBrowserController,
  type AgentBrowserObservation,
} from '@yantra/core';
import type { LocatorCandidate } from '@yantra/protocol';

import type { DomainFailure } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';

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
