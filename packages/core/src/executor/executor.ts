import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ConfirmationRequest, FailureClass, Step, TaskEvent } from '@yantra/protocol';
import { SCHEMA_VERSION, generateUlid } from '@yantra/protocol';

import { isParked } from './confirmation-gateway.js';
import type { ScopeViolationError } from './errors.js';
import { writeReport } from './report-writer.js';
import { checkScopeViolations } from './scope-enforcer.js';
import { STEP_DISPATCH } from './step-handlers/index.js';
import type { Checkpoint, ExecutionContext, RunOutcome, StepResult } from './types.js';

/** Maximum total step executions across all jumps/loops to prevent infinite loops. */
const MAX_TOTAL_STEP_EXECUTIONS = 1000;

/**
 * Plan executor — the deterministic heart of Yantra.
 *
 * `run(plan, ctx)` walks `plan.steps` linearly, emitting `TaskEvent`s at each
 * state transition and writing a checkpoint after every successful step.
 * Branch jumps and loops are handled by updating the step cursor.
 *
 * **Confirmation checkpoint (FEAT-019):** Before dispatching a step flagged
 * `requires_confirmation`, the executor builds a `ConfirmationRequest`,
 * persists it to `confirmations.jsonl`, emits a `confirmation_requested`
 * event, and blocks on the injected `ConfirmationGateway`. Only a
 * human-operated `ConnectorIO.confirm()` can resolve the request. Deny
 * or timeout terminates the run as a user-handoff abort (exit 4). The
 * grant is single-use and step-scoped — a re-execution after resume
 * re-requests (no blanket grants).
 *
 * `resumeFrom(checkpoint, ctx)` rehydrates from a persisted checkpoint and
 * continues from the step after the checkpointed one.
 */
export class Executor {
  /** Execute a complete plan from scratch. */
  async run(ctx: ExecutionContext): Promise<RunOutcome> {
    await mkdir(ctx.runDir, { recursive: true });

    // Defense-in-depth scope enforcement before any browser action
    const violations = checkScopeViolations(ctx.plan, { taskId: ctx.taskId, runId: ctx.runId });
    if (violations.length > 0) {
      const violation = violations[0]!;
      ctx.events.publish(buildScopeViolationEvent(ctx.taskId, violation));
      await ctx.events.flush();
      const reportPath = await writeReport(ctx.runDir, {
        runId: ctx.runId,
        taskId: ctx.taskId,
        plan: ctx.plan,
        status: 'failed',
        failureClass: 'scope_violation',
        failureMessage: violation.message,
        failedAtStepId: violation.scopeContext.stepId,
        completedStepIds: [],
        captureKeys: [],
        outputKeys: [],
      });
      ctx.events.publish({
        kind: 'task_failed',
        task_id: ctx.taskId,
        at: new Date().toISOString(),
        failure_class: 'scope_violation',
        report_path: reportPath,
      });
      await ctx.events.flush();
      return { status: 'failed', failureClass: 'scope_violation', reportPath };
    }

    ctx.events.publish({ kind: 'task_started', task_id: ctx.taskId, at: now() });

    return this.executeLoop(ctx, 0);
  }

  /**
   * Resume a run from a previously saved checkpoint.
   * The caller must provide a freshly launched `BrowserSession`.
   */
  async resumeFrom(checkpoint: Checkpoint, ctx: ExecutionContext): Promise<RunOutcome> {
    ctx.logger.info(
      { runId: ctx.runId, afterStepId: checkpoint.after_step_id },
      'resuming from checkpoint',
    );
    return this.executeLoop(ctx, checkpoint.after_step_idx + 1);
  }

  // ---------------------------------------------------------------------------
  // Internal execution loop
  // ---------------------------------------------------------------------------

  private async executeLoop(ctx: ExecutionContext, startIdx: number): Promise<RunOutcome> {
    const steps = ctx.plan.steps;
    const stepIdxMap = buildStepIdxMap(steps);
    const completedStepIds: string[] = [];

    let i = startIdx;
    let totalExecutions = 0;

    while (i < steps.length) {
      if (++totalExecutions > MAX_TOTAL_STEP_EXECUTIONS) {
        const reportPath = await this.emitFailure(
          ctx,
          'budget_exhausted',
          completedStepIds,
          null,
          [
            `Total step execution count exceeded ${MAX_TOTAL_STEP_EXECUTIONS} — possible infinite loop via branch jumps.`,
          ].join('\n'),
        );
        return { status: 'failed', failureClass: 'budget_exhausted', reportPath };
      }

      const step = steps[i]!;
      ctx.currentStepIdx = i;

      ctx.events.publish({
        kind: 'step_started',
        task_id: ctx.taskId,
        step_id: step.id,
        step_type: step.type,
        at: now(),
      });

      // ── Confirmation checkpoint (FEAT-019) ──────────────────────────
      // Before dispatching a flagged step (and before its ethics-gate call),
      // build a ConfirmationRequest, persist it, emit the event, and block
      // on the gateway. Grant → proceed; deny/timeout → handoff abort (exit 4).
      if (step.requires_confirmation) {
        const confirmOutcome = await this.runConfirmationCheckpoint(ctx, step, completedStepIds);
        if (confirmOutcome.kind !== 'granted') {
          return { status: 'handoff', reportPath: confirmOutcome.reportPath };
        }
      }

      const handler = STEP_DISPATCH.get(step.type);
      if (!handler) {
        const reportPath = await this.emitFailure(
          ctx,
          'unexpected',
          completedStepIds,
          step.id,
          `No handler registered for step type "${step.type}".`,
        );
        return { status: 'failed', failureClass: 'unexpected', reportPath };
      }

      let result: StepResult;
      let stepAttempt = 0;

      while (true) {
        result = await handler(step, ctx);

        if (result.kind === 'retried') {
          stepAttempt++;
          if (!ctx.budgets.canRetry('step')) {
            result = {
              kind: 'failed',
              failureClass: 'budget_exhausted',
              error: new Error(`Step retry budget exhausted after ${stepAttempt} attempt(s).`),
            };
            break;
          }
          ctx.budgets.consume('step');
          ctx.events.publish({
            kind: 'step_retry',
            task_id: ctx.taskId,
            step_id: step.id,
            attempt: stepAttempt,
            reason: result.reason as FailureClass,
            at: now(),
          });
          ctx.logger.warn(
            { stepId: step.id, attempt: stepAttempt, reason: result.reason },
            'step retry',
          );
          continue;
        }
        break;
      }

      // Handle result
      if (result.kind === 'completed') {
        completedStepIds.push(step.id);
        ctx.events.publish({
          kind: 'step_completed',
          task_id: ctx.taskId,
          step_id: step.id,
          capture_keys: [...(result.captureKeys ?? [])],
          at: now(),
        });
        await ctx.events.flush();

        // Write checkpoint
        const checkpoint: Checkpoint = {
          schema_version: SCHEMA_VERSION,
          run_id: ctx.runId,
          task_id: ctx.taskId,
          after_step_id: step.id,
          after_step_idx: i,
          ts: now(),
          page_url: ctx.page?.url() ?? null,
          captures: ctx.captures.snapshot(),
          scope_chain: [...ctx.scopeChain],
          budgets: ctx.budgets.snapshot(),
        };
        await ctx.checkpoints.save(checkpoint);
        ctx.events.publish({
          kind: 'checkpoint_saved',
          task_id: ctx.taskId,
          after_step_id: step.id,
          at: now(),
        });
        ctx.logger.info({ stepId: step.id, stepIdx: i }, 'step completed');
        i++;
        continue;
      }

      if (result.kind === 'jump') {
        completedStepIds.push(step.id);
        ctx.events.publish({
          kind: 'step_completed',
          task_id: ctx.taskId,
          step_id: step.id,
          capture_keys: [],
          at: now(),
        });
        const targetIdx = stepIdxMap.get(result.toStepId);
        if (targetIdx === undefined) {
          const reportPath = await this.emitFailure(
            ctx,
            'unexpected',
            completedStepIds,
            step.id,
            `Branch target step "${result.toStepId}" not found in plan.`,
          );
          return { status: 'failed', failureClass: 'unexpected', reportPath };
        }
        ctx.logger.debug({ fromStepId: step.id, toStepId: result.toStepId }, 'branch jump');
        i = targetIdx;
        continue;
      }

      if (result.kind === 'ethics_refused') {
        ctx.events.publish({
          kind: 'scope_violation', // reuse event for ethics refusals until a dedicated kind exists
          task_id: ctx.taskId,
          scope: ctx.scopeChain[i] ?? ctx.plan.default_scope,
          attempted_verb: step.type,
          step_id: step.id,
          at: now(),
        });
        ctx.logger.warn(
          { host: result.host, rule: result.rule, reason: result.reason },
          'ethics gate refused',
        );
        const reportPath = await this.emitFailure(
          ctx,
          'ethics_refused',
          completedStepIds,
          step.id,
          `Ethics gate refused access to "${result.host}": ${result.reason} (rule: ${result.rule})`,
        );
        return { status: 'failed', failureClass: 'ethics_refused', reportPath };
      }

      if (result.kind === 'handoff_requested') {
        await ctx.events.flush();
        const reportPath = await writeReport(ctx.runDir, {
          runId: ctx.runId,
          taskId: ctx.taskId,
          plan: ctx.plan,
          status: 'handoff',
          failedAtStepId: step.id,
          completedStepIds,
          captureKeys: ctx.captures.keys(),
          outputKeys: [],
        });
        ctx.events.publish({
          kind: 'human_handoff_requested',
          task_id: ctx.taskId,
          step_id: step.id,
          reason: result.reason,
          at: now(),
        });
        await ctx.events.flush();
        return { status: 'handoff', reportPath };
      }

      if (result.kind === 'failed') {
        ctx.logger.error(
          { stepId: step.id, failureClass: result.failureClass, error: result.error.message },
          'step failed',
        );
        const reportPath = await this.emitFailure(
          ctx,
          result.failureClass,
          completedStepIds,
          step.id,
          result.error.message,
        );
        return { status: 'failed', failureClass: result.failureClass, reportPath };
      }
    }

    // All steps completed — resolve outputs
    const outputKeys = resolveOutputKeys(ctx);
    await writeOutputsJson(ctx);

    await ctx.events.flush();
    ctx.events.publish({
      kind: 'task_completed',
      task_id: ctx.taskId,
      outputs_keys: outputKeys,
      at: now(),
    });
    await ctx.events.flush();
    await ctx.events.close();

    ctx.logger.info({ runId: ctx.runId, outputKeys }, 'task completed');
    return { status: 'completed', outputKeys };
  }

  // ---------------------------------------------------------------------------
  // Confirmation checkpoint (FEAT-019)
  // ---------------------------------------------------------------------------

  /**
   * Pre-step consent checkpoint for `requires_confirmation` steps.
   *
   * Builds a `ConfirmationRequest` from the step's annotations and resolved
   * host, persists it to `confirmations.jsonl`, emits a `confirmation_requested`
   * event, then awaits the gateway's decision. On grant, appends the decision
   * and emits `confirmation_resolved`. On deny/timeout, appends the decision,
   * emits the event, and terminates as a user-handoff abort (exit 4).
   *
   * The pause point is *before* the step, so resume-after-grant re-enters at
   * the same step cleanly. The grant is single-use and step-scoped.
   */
  private async runConfirmationCheckpoint(
    ctx: ExecutionContext,
    step: Step,
    completedStepIds: readonly string[],
  ): Promise<
    | { kind: 'granted' }
    | { kind: 'denied' | 'timed_out'; reportPath: string }
    | { kind: 'parked'; reportPath: string }
  > {
    if (!ctx.confirmationGateway) {
      // Fail-closed: no gateway + flagged step = abort, never silently skip.
      ctx.logger.error(
        { stepId: step.id, runId: ctx.runId },
        'confirmation required but no gateway is wired — aborting',
      );
      const reportPath = await this.writeConfirmationAbortReport(
        ctx,
        step,
        completedStepIds,
        'No confirmation gateway is wired — cannot request consent for a flagged step.',
      );
      return { kind: 'denied', reportPath };
    }

    const host = resolveHostForStep(step, ctx);
    const description =
      (step as { confirmation_description?: string | null }).confirmation_description ??
      `Execute ${step.type} on ${host}`;
    const expectedCost =
      (step as { expected_cost?: { amount: number; currency: string } | null }).expected_cost ??
      null;
    const consequence = (step as { consequence?: string | null }).consequence ?? 'unknown';

    const request: ConfirmationRequest = {
      confirmation_id: generateUlid(),
      run_id: ctx.runId,
      step_id: step.id,
      action_kind: step.type as 'click' | 'fill' | 'navigate',
      host,
      description,
      expected_cost: expectedCost,
      consequence: consequence as 'reversible' | 'hard_to_reverse' | 'irreversible' | 'unknown',
      requested_at: now(),
      timeout_ms: null,
    };

    // Persist the request
    if (ctx.confirmationStore) {
      await ctx.confirmationStore.appendRequest(request);
    }

    // Emit the request event
    ctx.events.publish({
      kind: 'confirmation_requested',
      task_id: ctx.taskId,
      at: now(),
      request,
    });
    await ctx.events.flush();

    // Block on the gateway — only a human-operated ConnectorIO can resolve this
    let outcome;
    try {
      outcome = await ctx.confirmationGateway.request(request);
    } catch (err) {
      // Gateway transport failure → fail-closed (treated as deny)
      ctx.logger.error(
        { stepId: step.id, err: err instanceof Error ? err.message : String(err) },
        'confirmation gateway failed — treating as deny',
      );
      outcome = {
        confirmation_id: request.confirmation_id,
        decision: 'denied' as const,
        decided_at: now(),
        decided_by: 'timeout' as const,
      };
    }

    // Park signal (unattended surfaces): DO NOT append a decision — the request
    // stays pending in confirmations.jsonl so `yantra confirm` can resolve it
    // later. The run is checkpointed before the flagged step (resumable) and
    // terminated as a handoff so the daemon can notify + move on (plan §6).
    if (isParked(outcome)) {
      ctx.logger.info(
        { stepId: step.id, confirmationId: request.confirmation_id },
        'confirmation parked — run stays pending for out-of-band consent',
      );
      const reportPath = await this.writeConfirmationAbortReport(
        ctx,
        step,
        completedStepIds,
        `Confirmation parked for step "${step.id}" — awaiting out-of-band consent.`,
      );
      ctx.events.publish({
        kind: 'human_handoff_requested',
        task_id: ctx.taskId,
        step_id: step.id,
        reason: 'other',
        at: now(),
      });
      await ctx.events.flush();
      return { kind: 'parked', reportPath };
    }

    const decision = outcome;

    // Persist the decision
    if (ctx.confirmationStore) {
      await ctx.confirmationStore.appendDecision(decision);
    }

    // Emit the resolution event
    ctx.events.publish({
      kind: 'confirmation_resolved',
      task_id: ctx.taskId,
      at: now(),
      confirmation_id: decision.confirmation_id,
      decision: decision.decision,
      decided_by: decision.decided_by,
    });
    await ctx.events.flush();

    if (decision.decision === 'granted') {
      ctx.logger.info(
        { stepId: step.id, confirmationId: request.confirmation_id },
        'confirmation granted — proceeding with step',
      );
      return { kind: 'granted' };
    }

    // Denied or timed_out → user-handoff abort
    ctx.logger.warn(
      { stepId: step.id, decision: decision.decision, decidedBy: decision.decided_by },
      'confirmation denied/timed_out — aborting run',
    );

    const reportPath = await this.writeConfirmationAbortReport(
      ctx,
      step,
      completedStepIds,
      `Confirmation ${decision.decision} by ${decision.decided_by} for step "${step.id}".`,
    );

    ctx.events.publish({
      kind: 'human_handoff_requested',
      task_id: ctx.taskId,
      step_id: step.id,
      reason: 'other',
      at: now(),
    });
    await ctx.events.flush();

    return { kind: decision.decision, reportPath };
  }

  /**
   * Writes the `report.md` for a confirmation abort (deny/timeout/no-gateway).
   * Reuses the same `writeReport` machinery as `handoff_requested`.
   */
  private async writeConfirmationAbortReport(
    ctx: ExecutionContext,
    step: Step,
    completedStepIds: readonly string[],
    message: string,
  ): Promise<string> {
    await ctx.events.flush();
    const reportPath = await writeReport(ctx.runDir, {
      runId: ctx.runId,
      taskId: ctx.taskId,
      plan: ctx.plan,
      status: 'handoff',
      failedAtStepId: step.id,
      completedStepIds: [...completedStepIds],
      captureKeys: ctx.captures.keys(),
      outputKeys: [],
    });
    ctx.logger.info({ stepId: step.id, reportPath, message }, 'confirmation abort report written');
    return reportPath;
  }

  private async emitFailure(
    ctx: ExecutionContext,
    failureClass: FailureClass,
    completedStepIds: string[],
    failedAtStepId: string | null,
    failureMessage: string,
  ): Promise<string> {
    await ctx.events.flush();
    const reportPath = await writeReport(ctx.runDir, {
      runId: ctx.runId,
      taskId: ctx.taskId,
      plan: ctx.plan,
      status: 'failed',
      failureClass,
      failureMessage,
      ...(failedAtStepId !== null ? { failedAtStepId } : {}),
      completedStepIds,
      captureKeys: ctx.captures.keys(),
      outputKeys: [],
    });
    ctx.events.publish({
      kind: 'task_failed',
      task_id: ctx.taskId,
      at: now(),
      failure_class: failureClass,
      report_path: reportPath,
    });
    await ctx.events.flush();
    await ctx.events.close();
    return reportPath;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStepIdxMap(steps: readonly Step[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    map.set(steps[i]!.id, i);
  }
  return map;
}

function buildScopeViolationEvent(taskId: string, violation: ScopeViolationError): TaskEvent {
  return {
    kind: 'scope_violation',
    task_id: taskId,
    scope: violation.scopeContext.scope,
    attempted_verb: violation.scopeContext.attemptedVerb,
    step_id: violation.scopeContext.stepId,
    at: now(),
  };
}

/**
 * Resolves the target host for a step — used to populate the
 * `ConfirmationRequest.host` field. For navigate steps, extracts from
 * the URL ValueRef. For click/fill, falls back to the current page URL
 * or a placeholder.
 */
function resolveHostForStep(step: Step, ctx: ExecutionContext): string {
  if (step.type === 'navigate') {
    const url = step.url;
    if (url.kind === 'literal' && typeof url.value === 'string') {
      try {
        return new URL(url.value).host;
      } catch {
        return url.value;
      }
    }
  }
  // Fall back to current page URL or a generic placeholder
  const pageUrl = ctx.page?.url();
  if (pageUrl) {
    try {
      return new URL(pageUrl).host;
    } catch {
      return pageUrl;
    }
  }
  return 'unknown';
}

function resolveOutputKeys(ctx: ExecutionContext): string[] {
  const keys: string[] = [];
  for (const output of ctx.plan.outputs) {
    if (ctx.captures.has(output.from.step_id)) {
      keys.push(output.name);
    }
  }
  return keys;
}

async function writeOutputsJson(ctx: ExecutionContext): Promise<void> {
  const outputs: Record<string, unknown> = {};
  for (const output of ctx.plan.outputs) {
    const captureValue = ctx.captures.get(output.from.step_id);
    if (captureValue !== undefined) {
      outputs[output.name] =
        output.from.field !== null
          ? typeof captureValue === 'object' && captureValue !== null
            ? (captureValue as Record<string, unknown>)[output.from.field]
            : null
          : captureValue;
    }
  }
  await writeFile(join(ctx.runDir, 'outputs.json'), JSON.stringify(outputs, null, 2), 'utf8');
}

function now(): string {
  return new Date().toISOString();
}
