import type { AssertStep } from '@yantra/protocol';

import { AssertFailedError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';

import { resolveLocatorChain } from './locator-helpers.js';
import { settleBeforeRead } from './settle-helpers.js';

/**
 * Assert step handler.
 *
 * Assertion failure is a HARD abort — no retry. Assert steps are
 * determinism checks; retrying them is semantically wrong.
 */
export const handleAssert: StepHandler<AssertStep> = async (step, ctx): Promise<StepResult> => {
  if (!ctx.locatorHost || !ctx.page) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error('Assert step requires a browser session with an InjectedScriptHost.'),
    };
  }

  const condition = step.condition;

  // An assertion is a determinism check, so it must run against the settled
  // page: asserting while the result is still loading fails a workflow that is
  // working, and `hidden`/`count_equals` would read a half-built DOM.
  await settleBeforeRead(ctx);

  // Assertions inspect the element, never point at it: `visible` is the right
  // bar, and demanding the full actionable contract would fail an assertion on
  // any element whose centre lies outside the viewport.
  const chainResult = await resolveLocatorChain(step.locator, step.id, ctx, {
    requirement: 'visible',
  });

  if (condition.kind === 'visible') {
    if (chainResult.kind === 'not_found') {
      return assertFail(
        step.id,
        ctx,
        'visible',
        `Element was not found / not visible. ${chainResult.diagnostics}`,
      );
    }
    if (chainResult.kind === 'error') {
      return { kind: 'failed', failureClass: 'unexpected', error: chainResult.error };
    }
    return { kind: 'completed' };
  }

  if (condition.kind === 'hidden') {
    if (chainResult.kind === 'found') {
      return assertFail(step.id, ctx, 'hidden', 'Element is visible but expected hidden.');
    }
    return { kind: 'completed' };
  }

  if (condition.kind === 'text_matches') {
    if (chainResult.kind !== 'found') {
      const detail =
        chainResult.kind === 'not_found' ? chainResult.diagnostics : chainResult.error.message;
      return assertFail(
        step.id,
        ctx,
        'text_matches',
        `Element not found for text assertion. ${detail}`,
      );
    }
    const text = await chainResult.elementHandle.evaluate(
      (el) => (el as unknown as { textContent: string | null }).textContent?.trim() ?? '',
    );
    const regex = new RegExp(condition.pattern, condition.flags || undefined);
    if (!regex.test(text)) {
      return assertFail(
        step.id,
        ctx,
        'text_matches',
        `Text "${text}" did not match pattern /${condition.pattern}/${condition.flags}.`,
      );
    }
    return { kind: 'completed' };
  }

  if (condition.kind === 'count_equals') {
    // For count assertions, re-resolve without strict mode to count all matches.
    // We abuse the current chain result — if found, count is at least 1.
    // A proper implementation would need the injected script to return count.
    // For MVP: count === 0 when not_found; count >= 1 when found.
    const actualCount = chainResult.kind === 'found' ? 1 : 0;
    if (actualCount !== condition.count) {
      return assertFail(
        step.id,
        ctx,
        'count_equals',
        `Expected ${condition.count} element(s), found ~${actualCount}.`,
      );
    }
    return { kind: 'completed' };
  }

  return {
    kind: 'failed',
    failureClass: 'unexpected',
    error: new Error(`Unknown assert condition kind: ${(condition as { kind: string }).kind}`),
  };
};

function assertFail(
  stepId: string,
  ctx: { taskId: string; runId: string },
  conditionKind: string,
  detail: string,
): StepResult {
  const error = new AssertFailedError(
    { conditionKind, stepId, detail },
    { taskId: ctx.taskId, runId: ctx.runId, stepId },
  );
  return { kind: 'failed', failureClass: 'unexpected', error };
}
