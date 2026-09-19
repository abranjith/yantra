/**
 * The one place a typed browser startup failure becomes an agent tool result.
 *
 * A browser starts lazily, on the first tool call that needs a page — so every
 * "no usable browser" condition surfaces *inside* a tool, not at run startup.
 * Without this table those typed causes reached the middleware's unexpected
 * branch and were flattened into `TOOL_EXECUTION_FAILED`: a retryable-looking
 * generic fault for a condition no retry can fix, with the remediation the core
 * error was carrying discarded on the way.
 *
 * Two rules keep this honest:
 *
 * 1. It classifies by `instanceof` against the real exported classes. A
 *    structurally-shaped double is not a browser startup failure, and reporting
 *    one as such would let a test prove something the production path does not.
 * 2. It returns `null` for anything it does not recognize. This mapper is total
 *    only over its declared table; a site fault, a Puppeteer bug, or a
 *    post-launch crash must keep going to the generic path unchanged.
 *
 * Every result is `retryable: false`. Nothing in this feature repairs a browser
 * mid-run, so an identical retry cannot succeed, and saying otherwise sends the
 * agent into a loop that burns the budget it needs to publish what it has.
 */

import {
  BrowserCompatibilityError,
  BrowserInstallOfferDeclinedError,
  BrowserLaunchError,
  BrowserManagedInstallError,
  BrowserProcessError,
  BrowserResolutionError,
  ChromeNotFoundError,
  ManagedCoordinationError,
} from '@yantra/core';

import { renderAgentMessage } from '../../../runtime/messages.js';
import type { DomainFailure } from '../../../runtime/middleware.js';

/**
 * The error classes this mapper is responsible for, by `name`.
 *
 * Exported so a test can assert coverage mechanically rather than by reading
 * the branches below. `BrowserCrashedError` is deliberately absent: it is a
 * post-launch session crash, not a startup refusal, and the in-run handling it
 * already has must not change.
 */
export const SUPPORTED_BROWSER_STARTUP_ERRORS: readonly string[] = Object.freeze([
  'BrowserResolutionError',
  'ChromeNotFoundError',
  'BrowserCompatibilityError',
  'ManagedCoordinationError',
  'BrowserLaunchError',
  'BrowserProcessError',
  'BrowserInstallOfferDeclinedError',
  'BrowserManagedInstallError',
]);

/**
 * The exit-class semantics the CLI already assigns these causes.
 *
 * Carried as a detail so downstream orchestration and audit keep the
 * distinction (environment 3 vs. user handoff 4) without the tool seam having
 * to abort the whole run the moment a browser refuses to start.
 */
type FailureClass = 'environment' | 'user-handoff';

/**
 * Projects a typed browser startup failure into a stable tool result, or
 * `null` when this is not one.
 *
 * @param error The exception a browser-backed tool caught.
 * @returns A non-retryable {@link DomainFailure}, or `null` to rethrow.
 */
export function mapBrowserStartupError(error: unknown): DomainFailure | null {
  // Ordered most specific first. `ChromeNotFoundError` and
  // `BrowserResolutionError` are siblings, not parent and child, so order
  // between them is presentational rather than load-bearing.
  if (error instanceof BrowserResolutionError) {
    return refusal('BROWSER_RESOLUTION_FAILED', 'resolution', {
      failure_class: 'environment',
      resolution_code: error.code,
      selection_source: error.requestedSelection.source,
    });
  }
  if (error instanceof ChromeNotFoundError) {
    return refusal('BROWSER_RESOLUTION_FAILED', 'resolution', {
      failure_class: 'environment',
      resolution_code: 'missing',
      selection_source: 'auto',
    });
  }
  if (error instanceof BrowserCompatibilityError) {
    return refusal('BROWSER_COMPATIBILITY_FAILED', 'capability', {
      failure_class: 'environment',
      compatibility_failure_class: error.context.failureClass,
      probe_profile: error.context.profile,
      browser_version: error.context.version,
      failed_capabilities: error.context.capabilities
        .filter((entry) => entry.status === 'failed')
        .map((entry) => entry.capability),
    });
  }
  if (error instanceof ManagedCoordinationError) {
    return refusal('BROWSER_COORDINATION_FAILED', 'coordination', {
      failure_class: 'environment',
      coordination_reason: error.context.reason,
    });
  }
  if (error instanceof BrowserLaunchError) {
    // Phase only. `args` and `lastStderr` are on the error and stay there:
    // a launch command line names the user's profile directory, and helper
    // stderr is arbitrary third-party output.
    return refusal('BROWSER_LAUNCH_FAILED', 'launch', {
      failure_class: 'environment',
      launch_phase: error.context.phase,
    });
  }
  if (error instanceof BrowserProcessError) {
    return refusal('BROWSER_PROCESS_FAILED', 'process', {
      failure_class: 'environment',
      process_phase: error.context.phase,
      // Worth surfacing: an unproven exit means a browser process may still be
      // running, which is a different cleanup story for the operator.
      exit_proven: error.context.exitProven,
    });
  }
  if (error instanceof BrowserInstallOfferDeclinedError) {
    return refusal('BROWSER_INSTALL_DECLINED', 'declined', {
      failure_class: 'user-handoff',
      handoff: true,
    });
  }
  if (error instanceof BrowserManagedInstallError) {
    return refusal('BROWSER_INSTALL_FAILED', 'managed-install', {
      failure_class: 'environment',
      install_code: error.installError.code,
      install_phase: error.installError.phase,
    });
  }
  return null;
}

/**
 * One refusal, built the same way every time.
 *
 * The model-visible message comes from the registered template — never from the
 * core error's own prose, which can embed an executable path, a loader dump, or
 * a raw helper `detail`. The closed structured fields go to `details`, which is
 * audit/UI only and never automatically shown to the model.
 */
function refusal(
  errorCode: string,
  cause: string,
  details: Readonly<Record<string, unknown>> & { readonly failure_class: FailureClass },
): DomainFailure {
  return {
    ok: false,
    errorCode,
    message: renderAgentMessage('tool', errorCode, cause),
    retryable: false,
    details,
  };
}
