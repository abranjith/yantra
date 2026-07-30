import type { LLMSummarizeStep } from '@yantra/protocol';
import { isExtractionErrorRow } from '@yantra/protocol';

import type { StepHandler, StepResult } from '../types.js';

/**
 * `llm_summarize` step handler.
 *
 * ## Two modes, one contract
 *
 * With a sanitizer and model client wired, this step sanitizes its input capture,
 * sends it to the model, and binds the summary to `output_as`.
 *
 * With either dependency absent it **passes the input through**: the raw input
 * capture is bound to `output_as` unchanged and a `llm_step_skipped` event
 * records why. It does not fail.
 *
 * That is deliberate, and it is what makes the step usable at all. A workflow
 * containing an `llm_summarize` step must stay runnable — and *schedulable* —
 * without a model, because unattended surfaces are hard zero-LLM by policy: a
 * scheduled fire never opens a provider session. Failing the step instead would
 * mean a workflow that can be saved but never replayed on a timer, and would make
 * one optional enrichment step fatal to an otherwise deterministic run. Callers
 * downstream still get a value at `output_as`; it is the extracted text rather
 * than a summary of it.
 *
 * A **missing input capture** remains a failure. That is an authoring bug — the
 * step references a capture no earlier step produces — not a mode difference, and
 * silently binding `undefined` would hide it.
 */
export const handleLlmSummarize: StepHandler<LLMSummarizeStep> = async (
  step,
  ctx,
): Promise<StepResult> => {
  // Resolve the input capture first: an unresolvable input is an authoring bug
  // in either mode, so it must not be masked by the pass-through path.
  const capture = ctx.captures.get(step.input.step_id);
  if (capture === undefined) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error(
        `llm_summarize step "${step.id}": capture "${step.input.step_id}" not found.`,
      ),
    };
  }

  if (!ctx.sanitizer || !ctx.llmClient) {
    return passThrough(step, ctx, capture);
  }

  // For ExtractionResultEnvelope captures, pass only valid rows to the LLM
  let inputPayload: unknown = capture;
  if (
    typeof capture === 'object' &&
    capture !== null &&
    'rows' in (capture as Record<string, unknown>) &&
    'metadata' in (capture as Record<string, unknown>)
  ) {
    const envelope = capture as { rows: unknown[] };
    inputPayload = { rows: envelope.rows.filter((r) => !isExtractionErrorRow(r)) };
  }

  // Sanitize before sending to LLM
  const effectiveScope = ctx.scopeChain[ctx.currentStepIdx] ?? ctx.plan.default_scope;
  const sanitized = ctx.sanitizer.sanitize(inputPayload, effectiveScope);

  // Call LLM
  let llmResult: Awaited<ReturnType<NonNullable<typeof ctx.llmClient>['summarize']>>;
  try {
    llmResult = await ctx.llmClient.summarize(sanitized.text, step.prompt);
  } catch (err) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
  // Store the summarized text
  ctx.captures.set(step.output_as, llmResult.text);

  return { kind: 'completed', captureKeys: [step.output_as] };
};

/**
 * Binds the raw input to `output_as` and records the skip.
 *
 * The event is the audit trail for a Brief or output that is less refined than
 * the workflow author asked for — without it, a summary-shaped output silently
 * containing raw page text would be indistinguishable from a real summary.
 */
function passThrough(
  step: LLMSummarizeStep,
  ctx: Parameters<StepHandler<LLMSummarizeStep>>[1],
  capture: unknown,
): StepResult {
  const reason =
    ctx.llmClient === null
      ? 'no model client is configured for this run'
      : 'no sanitizer is configured for this run';

  ctx.captures.set(step.output_as, capture);

  ctx.events.publish({
    kind: 'llm_step_skipped',
    task_id: ctx.taskId,
    at: new Date(ctx.clock.now()).toISOString(),
    step_id: step.id,
    output_as: step.output_as,
    reason,
  });

  ctx.logger.info(
    { stepId: step.id, outputAs: step.output_as, reason },
    'llm_summarize passed its input through unchanged',
  );

  return { kind: 'completed', captureKeys: [step.output_as] };
}
