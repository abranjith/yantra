/**
 * The CLI run-start sweep (FEAT-064 TASK-010): when a `run`-class command
 * starts, runs whose owner died are reconciled in the background. It never
 * delays the command's start, never surfaces an error, and is awaited for at
 * most its budget before the process exits.
 */

import { reconcileAll, type Logger, type SweepResult } from '@yantra/core';

/** How long a run-start sweep may keep working, from its start. */
export const RUN_START_SWEEP_BUDGET_MS = 5_000;

/** A sweep in flight. */
export interface RunStartSweep {
  /** Resolves when the sweep finished or its budget ran out, whichever is first. */
  settle(): Promise<void>;
}

export interface RunStartSweepDeps {
  readonly reconcile?: typeof reconcileAll;
  readonly logger?: Pick<Logger, 'debug'>;
  readonly now?: () => number;
  /** Delay seam: resolves after `ms`. */
  readonly wait?: (ms: number) => Promise<void>;
  readonly budgetMs?: number;
}

/** Starts the sweep without waiting for it. */
export function startRunStartSweep(deps: RunStartSweepDeps = {}): RunStartSweep {
  const now = deps.now ?? (() => performance.now());
  const budgetMs = deps.budgetMs ?? RUN_START_SWEEP_BUDGET_MS;
  const started = now();
  const running: Promise<SweepResult | null> = (deps.reconcile ?? reconcileAll)({
    trigger: 'cli',
    budgetMs,
  }).catch((error: unknown) => {
    deps.logger?.debug(
      {
        event: 'run_start_sweep_failed',
        error_class: error instanceof Error ? error.name : typeof error,
      },
      'run_start_sweep_failed',
    );
    return null;
  });
  const wait =
    deps.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms).unref();
      }));
  return {
    settle: async () => {
      const left = Math.max(0, budgetMs - (now() - started));
      await Promise.race([running.then(() => undefined), wait(left)]);
    },
  };
}
