import type { FillStep } from '@yantra/protocol';

import { ExecutorLocatorNotFoundError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';
import { ValueResolver } from '../value-resolver.js';

import { resolveLocatorChain } from './locator-helpers.js';
import { FILL_NAV_DETECT_MS, withPageSettling } from './settle-helpers.js';

/**
 * Fill step handler.
 *
 * Secrets are resolved here and ONLY here. The resolved plaintext is typed
 * into the element and then immediately zero-ed via the `ResolvedSecret.zero()`
 * callback. The `step_completed` event never carries the value.
 *
 * The fill (and its optional Enter submit) is wrapped in the shared
 * page-settling wait: search-as-you-type and auto-submitting forms navigate on
 * a fill, and a submitting fill is exactly the case where the next step must
 * not read the old document.
 */
export const handleFill: StepHandler<FillStep> = async (step, ctx): Promise<StepResult> => {
  if (!ctx.locatorHost || !ctx.page) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error('Fill step requires a browser session with an InjectedScriptHost.'),
    };
  }

  // Fill synthesizes pointer and keyboard input, so it needs the full
  // actionable contract.
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

  let plaintext: string;
  let zeroSecret: (() => void) | null = null;

  try {
    if (step.value.kind === 'secret') {
      const resolved = await new ValueResolver(
        ctx.captures,
        ctx.params ?? {},
        ctx.secrets,
      ).resolveSecret(step.value);
      plaintext = resolved.plaintext;
      zeroSecret = resolved.zero;
    } else {
      const resolver = new ValueResolver(ctx.captures, ctx.params ?? {}, ctx.secrets);
      plaintext = await resolver.resolveToString(step.value);
    }
  } catch (err) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  try {
    await withPageSettling(ctx, FILL_NAV_DETECT_MS, async () => {
      await elementHandle.focus();
      await elementHandle.click({ clickCount: 3 }); // select all
      await elementHandle.type(plaintext);

      if (step.submit) {
        await elementHandle.press('Enter');
      }
    });
  } catch (err) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  } finally {
    // Zero the secret reference immediately after use (best-effort)
    zeroSecret?.();
  }

  // Return completed with no value in the event — type system enforces this
  return { kind: 'completed' };
};
