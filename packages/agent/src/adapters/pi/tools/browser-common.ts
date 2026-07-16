import {
  BrowserActionabilityError,
  StaleElementRefError,
  type AgentBrowserController,
} from '@yantra/core';

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
