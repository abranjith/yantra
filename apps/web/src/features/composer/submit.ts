/**
 * Submits a composed command exactly once (FEAT-067 TASK-011, plan D11).
 *
 * - The invocation ID is generated once per submission and reused on every
 *   retry: the host's `command.invoke` is idempotent per ID, so a retry after
 *   a lost response returns the existing record and never launches twice.
 * - A lost response (the socket dropped) or no answer within the timeout is
 *   retried with backoff, at most 3 times. A refusal from the host (bad
 *   arguments, a busy resource, a command the app cannot run) is not retried:
 *   it is the answer, shown inline.
 * - `displayed_effective` is exactly what the composer showed at submit time,
 *   the baseline for queue drift review (D13). It never holds a secret.
 */

import type {
  CommandInvocation,
  DisplayedEffective,
  EffectiveOptions,
  InvocationSummary,
} from '@yantra/protocol';

import type { AppRpc } from '../../host/app-rpc.js';
import { RpcCallError } from '../../host/rpc-client.js';

import { toInvocation, type ComposerModel } from './composer-model.js';

/** Retries after the first attempt. */
export const SUBMIT_RETRIES = 3;
/** How long one attempt waits for an answer. */
export const SUBMIT_TIMEOUT_MS = 15_000;
/** The backoff before retry `n` (1-based). */
export function submitBackoffMs(retry: number): number {
  return 500 * 2 ** (retry - 1);
}

/** What submitting needs besides the RPC handle. */
export interface SubmitDeps {
  /** A fresh invocation ID (default `crypto.randomUUID()`). */
  readonly createId?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Races one attempt against the timeout (tests inject an instant one). */
  readonly timeout?: <T>(attempt: Promise<T>, ms: number) => Promise<T>;
}

/** The host refused the invocation; show `message` and `remediation` inline. */
export class SubmitRefusedError extends Error {
  public override readonly name = 'SubmitRefusedError';
  public constructor(
    message: string,
    public readonly reason: string,
    public readonly remediation: string | undefined,
  ) {
    super(message);
  }
}

/** No answer after every retry: the start outcome is unknown to this window. */
export class SubmitLostError extends Error {
  public override readonly name = 'SubmitLostError';
  public constructor(public readonly invocationId: string) {
    super(
      'Yantra did not answer. The run may have started; check the Ledger before starting it again.',
    );
  }
}

class AttemptTimeout extends Error {
  public override readonly name = 'AttemptTimeout';
}

function defaultTimeout<T>(attempt: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new AttemptTimeout());
    }, ms);
    attempt.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** What the composer showed at submit time, as the drift baseline. */
export function displayedEffective(effective: EffectiveOptions | null): DisplayedEffective {
  return {
    settings: (effective?.options ?? []).map((item) => ({
      key: item.option,
      value: item.value,
      source: item.source,
    })),
    content: [],
  };
}

/** The submitted invocation and the host's answer. */
export interface Submitted {
  readonly invocation: CommandInvocation;
  readonly summary: InvocationSummary;
}

/** See the module comment. */
export async function submitInvocation(
  rpc: AppRpc,
  submission: {
    readonly model: ComposerModel;
    readonly effective: EffectiveOptions | null;
    readonly cwd: string;
  },
  deps: SubmitDeps = {},
): Promise<Submitted> {
  const invocationId = (deps.createId ?? (() => crypto.randomUUID()))();
  const invocation = toInvocation(submission.model, { invocationId, cwd: submission.cwd });
  const params = {
    invocation,
    displayed_effective: displayedEffective(submission.effective),
  };
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeout = deps.timeout ?? defaultTimeout;
  for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(submitBackoffMs(attempt));
    try {
      const summary = await timeout(
        rpc.request<InvocationSummary>('command.invoke', params),
        SUBMIT_TIMEOUT_MS,
      );
      return { invocation, summary };
    } catch (error) {
      if (error instanceof RpcCallError) {
        throw new SubmitRefusedError(error.message, error.reason, error.remediation);
      }
      // A dropped socket or no answer: the same ID again is safe (D11).
    }
  }
  throw new SubmitLostError(invocationId);
}
