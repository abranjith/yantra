import {
  BrowserActionabilityError,
  StaleElementRefError,
  type AgentBrowserController,
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

export function isDomainFailure(
  value: AgentBrowserController | DomainFailure,
): value is DomainFailure {
  return 'ok' in value && value.ok === false;
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
