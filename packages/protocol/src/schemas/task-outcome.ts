import { z } from 'zod';

/**
 * The task-outcome vocabulary every command shares (FEAT-054, plan D3).
 *
 * The outcome says whether the user's task was done, which is a separate
 * question from whether an artifact was saved: a `partial` run keeps its Brief
 * and still did not do everything the contract declared. `ask` and `research`
 * use the same words with their own criteria; `run` maps its replay outcomes
 * onto them.
 */
export const TaskOutcome = z
  .enum(['fulfilled', 'partial', 'handoff', 'failed', 'aborted'])
  .describe(
    'Whether the task was done: fulfilled (every declared requirement met), partial (a result was saved but a requirement is unmet or no contract was declared), handoff (the run needs the user), failed (nothing usable was saved), or aborted (the user interrupted).',
  );

export type TaskOutcome = z.infer<typeof TaskOutcome>;

/**
 * Why the run stopped, recorded separately from {@link TaskOutcome}. A
 * `partial` run that ran out of exploration time and one whose model simply
 * finished early end with the same outcome and different reasons.
 */
export const TerminationReason = z
  .enum([
    'model_finished',
    'wall-clock-soft',
    'wall-clock-hard',
    'provider-tokens',
    'tool-budget',
    'repeated-tool-failure',
    'handoff',
    'user_abort',
    'provider_failed',
    'stalled',
    'turn-timeout',
  ])
  .describe(
    'Why the run stopped: stalled (no progress after recovery), turn-timeout (thinking limit), the model finished, a budget or the repeated-failure breaker ended it, a handoff was raised, the user aborted, or the provider failed. wall-clock-soft means the model finished after the exploration wind-down began.',
  );

export type TerminationReason = z.infer<typeof TerminationReason>;
