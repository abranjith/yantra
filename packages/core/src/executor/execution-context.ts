import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Plan } from '@yantra/protocol';

import type { BrowserSession, Logger, Page } from '../browser/types.js';

import { InMemoryCaptureStore } from './capture-store.js';
import { FilesystemCheckpointStore } from './checkpoint-store.js';
import { createConfirmationStore } from './confirmation-gateway.js';
import type { ConfirmationGateway } from './confirmation-gateway.js';
import { JsonlEventBus } from './event-bus.js';
import { RetryBudgetImpl } from './retry-budget.js';
import { buildScopeChain } from './scope-enforcer.js';
import type {
  CaptureSnapshot,
  CaptureStore,
  CheckpointStore,
  Clock,
  EthicsGate,
  EventBus,
  ExecutionContext,
  LLMClient,
  RetryBudget,
  RetryBudgetLevels,
  Sanitizer,
  SecretResolver,
  WorkflowLocatorStore,
} from './types.js';
import { realClock } from './types.js';

export interface ExecutionContextOptions {
  readonly runId?: string;
  readonly taskId: string;
  readonly plan: Plan;
  readonly runDir: string;
  readonly browser?: BrowserSession | null;
  readonly page?: Page | null;
  readonly secrets?: SecretResolver | null;
  readonly sanitizer?: Sanitizer | null;
  readonly llmClient?: LLMClient | null;
  readonly workflowLocators?: WorkflowLocatorStore | null;
  readonly ethics: EthicsGate;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly budgets?: Partial<RetryBudgetLevels>;
  readonly confirmationGateway?: ConfirmationGateway | null;
}

/**
 * Factory that assembles a complete `ExecutionContext` from task inputs.
 *
 * Pre-computes the scope chain and validates basic plan invariants
 * (non-empty steps, unique IDs). These are defense-in-depth checks;
 * the semantic validator in `packages/protocol` should already have run.
 */
export function createExecutionContext(opts: ExecutionContextOptions): ExecutionContext {
  const runId = opts.runId ?? randomUUID();
  const clock = opts.clock ?? realClock;

  // Defense-in-depth: validate plan non-empty and unique step IDs
  if (opts.plan.steps.length === 0) {
    throw new Error(`Plan "${opts.plan.plan_id}" has no steps.`);
  }
  const stepIds = new Set<string>();
  for (const step of opts.plan.steps) {
    if (stepIds.has(step.id)) {
      throw new Error(`Duplicate step ID "${step.id}" in plan "${opts.plan.plan_id}".`);
    }
    stepIds.add(step.id);
  }

  const captures: CaptureStore = new InMemoryCaptureStore();
  const scopeChain = buildScopeChain(opts.plan);
  const events: EventBus = new JsonlEventBus(join(opts.runDir, 'events.jsonl'));
  const checkpoints: CheckpointStore = new FilesystemCheckpointStore(
    join(opts.runDir, 'checkpoints'),
  );
  const budgets: RetryBudget = new RetryBudgetImpl(opts.budgets ?? {}, {
    taskId: opts.taskId,
    runId,
  });

  return {
    runId,
    taskId: opts.taskId,
    plan: opts.plan,
    currentStepIdx: 0,
    captures,
    secrets: opts.secrets ?? null,
    sanitizer: opts.sanitizer ?? null,
    llmClient: opts.llmClient ?? null,
    workflowLocators: opts.workflowLocators ?? null,
    browser: opts.browser ?? null,
    page: opts.page ?? null,
    locatorHost: opts.page?.locatorHost ?? null,
    events,
    budgets,
    ethics: opts.ethics,
    checkpoints,
    scopeChain,
    logger: opts.logger,
    clock,
    runDir: opts.runDir,
    confirmationGateway: opts.confirmationGateway ?? null,
    confirmationStore: createConfirmationStore(opts.runDir),
  };
}

/**
 * Lazily attaches the run's single browser page and its production locator
 * host. Deterministic replay calls this before dispatching its first step.
 */
export async function ensureExecutionBrowser(ctx: ExecutionContext): Promise<void> {
  if (ctx.page !== null) {
    ctx.locatorHost ??= ctx.page.locatorHost ?? null;
    return;
  }
  if (ctx.browser === null) return;
  const page = await ctx.browser.newPage();
  ctx.page = page;
  ctx.locatorHost = page.locatorHost ?? null;
}

/**
 * Restores an `ExecutionContext` from a saved checkpoint.
 * Used by `Executor.resumeFrom()`.
 */
export function restoreExecutionContext(
  base: ExecutionContext,
  snapshot: {
    readonly after_step_idx: number;
    readonly captures: CaptureSnapshot;
    readonly budgets: { locator: number; step: number; workflow: number };
  },
): ExecutionContext {
  const captures = new InMemoryCaptureStore();
  captures.restore(snapshot.captures);

  const budgets = new RetryBudgetImpl(
    {
      locatorAttempts: snapshot.budgets.locator,
      stepAttempts: snapshot.budgets.step,
      workflowAttempts: snapshot.budgets.workflow,
    },
    { taskId: base.taskId, runId: base.runId },
  );

  return {
    ...base,
    currentStepIdx: snapshot.after_step_idx + 1,
    captures,
    budgets,
    page: null,
    locatorHost: null,
  };
}
