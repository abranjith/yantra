import type { LLMSummarizeStep } from '@yantra/protocol';
import { isExtractionErrorRow } from '@yantra/protocol';

import type { StepHandler, StepResult } from '../types.js';

/**
 * LLMSummarize step handler — stub-friendly.
 *
 * When `Sanitizer` and `LLMClient` are wired into the ExecutionContext this
 * handler sanitizes the input capture, sends it to the LLM, stores the
 * result, and records usage via `UsageWriter`. Tagged `@requires-llm`.
 *
 * When either dependency is absent, returns a structured failure so tests
 * can exercise the dispatch path without an actual LLM call.
 */
export const handleLlmSummarize: StepHandler<LLMSummarizeStep> = async (
  step,
  ctx,
): Promise<StepResult> => {
  if (!ctx.sanitizer || !ctx.llmClient) {
    return {
      kind: 'failed',
      failureClass: 'unexpected',
      error: new Error(
        `llm_summarize step "${step.id}" requires FEAT-006 (Sanitizer) + FEAT-011 (LLMClient). ` +
          'Set LLM_PROVIDER=none to use the rule-based path.',
      ),
    };
  }

  // Resolve the input capture
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
    llmResult = await ctx.llmClient.summarize(sanitized, step.prompt);
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
