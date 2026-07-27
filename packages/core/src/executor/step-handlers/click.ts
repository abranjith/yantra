import type { ClickStep } from '@yantra/protocol';

import { ExecutorLocatorNotFoundError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';

import { resolveLocatorChain } from './locator-helpers.js';
import { CLICK_NAV_DETECT_MS, withPageSettling } from './settle-helpers.js';

/**
 * Click step handler.
 *
 * Resolves the locator via `resolveActionable` (FEAT-004 auto-wait),
 * then calls `elementHandle.click()` with optional keyboard modifiers.
 * Does NOT contain its own locator-retry loop — FEAT-004 owns that layer.
 * Step-level retries are the executor's responsibility.
 *
 * The click is wrapped in the shared page-settling wait, so the step does not
 * complete until whatever the click set in motion — a navigation the site
 * schedules late, a redirect chain, a fetch that paints the result — has
 * landed. Without it the next step reads the pre-click document.
 */
export const handleClick: StepHandler<ClickStep> = async (step, ctx): Promise<StepResult> => {
  if (!ctx.locatorHost || !ctx.page) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error('Click step requires a browser session with an InjectedScriptHost.'),
    };
  }

  // Click synthesizes pointer input, so it needs the full actionable contract.
  const chainResult = await resolveLocatorChain(step.locator, step.id, ctx, {
    requirement: 'actionable',
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
    if (ctx.budgets.canRetry('step')) {
      return {
        kind: 'retried',
        attempt: 1,
        reason: 'Locator chain exhausted — DOM may have re-rendered',
      };
    }
    return { kind: 'failed', failureClass: 'locator_not_found', error: locErr };
  }
  if (chainResult.kind === 'error') {
    return { kind: 'failed', failureClass: 'unexpected', error: chainResult.error };
  }

  const { elementHandle } = chainResult;

  try {
    await withPageSettling(ctx, CLICK_NAV_DETECT_MS, () =>
      elementHandle.click({
        button: 'left',
        ...(step.modifiers
          ? {
              clickCount: 1,
            }
          : {}),
      }),
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { kind: 'failed', failureClass: 'unexpected', error };
  }

  return { kind: 'completed' };
};
