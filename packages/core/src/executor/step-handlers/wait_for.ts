import type { WaitForStep } from '@yantra/protocol';

import { ExecutorLocatorNotFoundError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';

import { resolveLocatorChain } from './locator-helpers.js';

/**
 * Per-probe deadline for the inverse (`hidden`/`detached`) poll. Short by
 * design: each probe only has to answer "is it still there right now?", and the
 * enclosing loop owns the real wait budget.
 */
const PROBE_TIMEOUT_MS = 500;

/**
 * WaitFor step handler.
 *
 * Uses the FEAT-004 `resolveActionable` auto-wait loop for the `visible`
 * and `attached` states. For `hidden` and `detached`, polls until the element
 * is no longer present/visible (inverse resolution).
 */
export const handleWaitFor: StepHandler<WaitForStep> = async (step, ctx): Promise<StepResult> => {
  if (!ctx.locatorHost || !ctx.page) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error('WaitFor step requires a browser session with an InjectedScriptHost.'),
    };
  }

  const timeoutMs = step.timeout_ms ?? 30_000;

  if (step.state === 'visible' || step.state === 'attached') {
    // The awaited state IS the requirement — waiting for `attached` must not
    // additionally demand visibility or a winning hit test, and waiting for
    // `visible` must not demand pointer actionability.
    const chainResult = await resolveLocatorChain(step.locator, step.id, ctx, {
      requirement: step.state,
      timeoutMs,
    });
    if (chainResult.kind === 'not_found') {
      const locErr = new ExecutorLocatorNotFoundError(
        {
          chainName: chainResult.chainName,
          candidatesCount: chainResult.candidatesCount,
          diagnostics: chainResult.diagnostics,
        },
        { taskId: ctx.taskId, runId: ctx.runId, stepId: step.id },
      );
      return { kind: 'failed', failureClass: 'locator_not_found', error: locErr };
    }
    if (chainResult.kind === 'error') {
      return { kind: 'failed', failureClass: 'unexpected', error: chainResult.error };
    }
    return { kind: 'completed' };
  }

  // For 'hidden' and 'detached', poll until locator fails to resolve. Each
  // probe gets a short deadline of its own: with the 30s default, a single
  // probe would swallow the entire wait budget before the loop could poll a
  // second time, and a `hidden` wait could never observe the transition.
  const deadline = ctx.clock.now() + timeoutMs;
  while (ctx.clock.now() < deadline) {
    const chainResult = await resolveLocatorChain(step.locator, step.id, ctx, {
      // 'hidden' probes for a visible element; 'detached' probes for presence.
      requirement: step.state === 'hidden' ? 'visible' : 'attached',
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (chainResult.kind === 'not_found') {
      return { kind: 'completed' };
    }
    if (chainResult.kind === 'error') {
      // On error, treat element as gone (detached/hidden)
      return { kind: 'completed' };
    }
    // Element still present — wait a bit
    await sleep(100, ctx.clock);
  }

  return {
    kind: 'failed',
    failureClass: 'unexpected',
    error: new Error(
      `WaitFor step "${step.id}": element did not become ${step.state} within ${timeoutMs}ms.`,
    ),
  };
};

function sleep(
  ms: number,
  clock: { setTimeout: (fn: () => void, ms: number) => unknown },
): Promise<void> {
  return new Promise((resolve) => {
    const handle = clock.setTimeout(resolve, ms);
    if (typeof (handle as NodeJS.Timeout).unref === 'function') {
      (handle as NodeJS.Timeout).unref();
    }
  });
}
