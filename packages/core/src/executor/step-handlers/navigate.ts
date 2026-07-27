import type { FailureClass, NavigateStep } from '@yantra/protocol';

import { EthicsRefusedError, NavigationTimeoutError, RemoteRefusedError } from '../errors.js';
import type { StepHandler, StepResult } from '../types.js';
import { ValueResolver } from '../value-resolver.js';

import { settleAfterNavigation } from './settle-helpers.js';

const DEFAULT_NAV_TIMEOUT_MS = 30_000;

/**
 * Navigate step handler.
 *
 * Ethics gate is the FIRST call — before any browser interaction.
 * The handler resolves the URL, calls `EthicsGate.check`, then navigates.
 * Redirect checking is enforced when `allow_redirect` is not set.
 */
export const handleNavigate: StepHandler<NavigateStep> = async (step, ctx): Promise<StepResult> => {
  const resolver = new ValueResolver(ctx.captures, getParams(), ctx.secrets);

  let resolvedUrl: string;
  try {
    resolvedUrl = await resolver.resolveToString(step.url);
  } catch (err) {
    return fail('unexpected', err);
  }

  // Ethics gate — non-bypassable, always first
  try {
    await ctx.ethics.check(resolvedUrl, 'navigate', {
      taskId: ctx.taskId,
      runId: ctx.runId,
      stepId: step.id,
    });
  } catch (err) {
    if (err instanceof EthicsRefusedError) {
      return {
        kind: 'ethics_refused',
        host: err.ethicsContext.host,
        rule: err.ethicsContext.rule,
        reason: err.ethicsContext.reason,
      };
    }
    return fail('ethics_refused', err);
  }

  if (!ctx.page) {
    return fail('unexpected', new Error('No active page in ExecutionContext.'));
  }

  const host = extractHost(resolvedUrl);

  try {
    const response = await ctx.page.goto(resolvedUrl, {
      waitUntil: 'load',
    });

    if (response && typeof response === 'object' && 'status' in response) {
      const status = (response as { status(): number }).status();
      if (status === 429 || status === 403 || status === 451) {
        const retryAfterMs = extractRetryAfter(response);
        const remoteContext: {
          readonly status: number;
          readonly host: string;
          readonly url: string;
          readonly retryAfterMs?: number;
        } =
          retryAfterMs !== undefined
            ? { status, host, url: resolvedUrl, retryAfterMs }
            : { status, host, url: resolvedUrl };
        const remoteErr = new RemoteRefusedError(remoteContext, {
          taskId: ctx.taskId,
          runId: ctx.runId,
          stepId: step.id,
        });
        if (status === 429 && retryAfterMs !== undefined) {
          return { kind: 'retried', attempt: 1, reason: `HTTP 429 Retry-After: ${retryAfterMs}ms` };
        }
        return { kind: 'failed', failureClass: remoteErr.failureClass, error: remoteErr };
      }
    }
  } catch (err) {
    if (isTimeoutError(err)) {
      const navErr = new NavigationTimeoutError(
        { url: resolvedUrl, timeoutMs: DEFAULT_NAV_TIMEOUT_MS },
        { taskId: ctx.taskId, runId: ctx.runId, stepId: step.id },
      );
      return { kind: 'failed', failureClass: navErr.failureClass, error: navErr };
    }
    return fail('unexpected', err);
  }

  // Real pages often bounce once more right after load (JS or meta-refresh
  // redirects, client-side routers) and keep fetching their content. Settle
  // those before the next step acts, so it does not resolve locators against a
  // document that is about to be replaced.
  await settleAfterNavigation(ctx);

  return { kind: 'completed' };
};

function fail(failureClass: FailureClass, err: unknown): StepResult {
  const error = err instanceof Error ? err : new Error(String(err));
  return { kind: 'failed', failureClass, error };
}

function getParams(): Record<string, unknown> {
  // Params are embedded in plan metadata — for MVP, use empty params
  // FEAT-010 / FEAT-012 will wire actual task params via ExecutionContext
  return {};
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('timeout') || msg.includes('timed out');
}

function extractRetryAfter(response: unknown): number | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const headers = (response as Record<string, unknown>).headers;
  if (typeof headers !== 'function') return undefined;
  const retryAfter = (headers as () => Record<string, string>)()['retry-after'];
  if (!retryAfter) return undefined;
  const seconds = parseInt(retryAfter, 10);
  return isNaN(seconds) ? undefined : seconds * 1000;
}
