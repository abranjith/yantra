import type { Plan, UsageCall, ValidationError } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';
import { PlanSchema } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';
import { SCHEMA_VERSION } from '@yantra/protocol';

import type { GeneratePlanOpts, GeneratePlanResult, LLMError } from '../client/interface.js';
import type { AssembleOpts } from '../prompts/assemble.js';
import { assemble } from '../prompts/assemble.js';
import { buildRePrompt } from '../prompts/reprompt.js';
import { assertSanitized } from '../sanitizer-guard.js';

import { dominantErrorCode, resolveUserFacingHint } from './user-facing-hints.js';
import { validatePlanSemantics } from './validate.js';

// ---------------------------------------------------------------------------
// Internal raw-call interface (not exposed on LLMClient)
// ---------------------------------------------------------------------------

export interface RawCallResult {
  readonly rawResponse: unknown;
  readonly toolCalls: readonly { tool: string; input: unknown }[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly latencyMs: number;
}

export interface RawCallClient {
  rawCall(
    systemPrompt: string,
    userMessage: string,
    runId: string,
    taskId: string,
  ): Promise<Result<RawCallResult, LLMError>>;
}

// ---------------------------------------------------------------------------
// generatePlan orchestration
// ---------------------------------------------------------------------------

/**
 * End-to-end plan generation flow:
 * 1. Sanitizer check (defense-in-depth)
 * 2. System-prompt assembly
 * 3. Provider call (via rawCall on the concrete client)
 * 4. Schema validation (Zod)
 * 5. Semantic validation (FEAT-002)
 * 6. On failure: build re-prompt context and retry up to budget.maxCalls
 *
 * Used by both AnthropicLLMClient and OllamaLLMClient — provider-specific code
 * is the rawCall() method; this orchestration is shared.
 */
export async function runGeneratePlan(
  opts: GeneratePlanOpts,
  rawCallClient: RawCallClient,
  guidanceMarkdown: string,
): Promise<Result<GeneratePlanResult, LLMError>> {
  // Step 1: Runtime sanitizer guard (belt-and-suspenders — type already enforces this)
  assertSanitized(opts.sanitizedPrompt);

  const assembleOpts: AssembleOpts = {
    toolCatalog: opts.toolCatalog,
    schemaVersion: SCHEMA_VERSION,
    guidanceMarkdown,
  };

  const accumulatedUsage: UsageCall[] = [];
  const allErrors: ValidationError[] = [];
  let attempt = 0;
  let userMessage = opts.sanitizedPrompt as unknown as string;

  while (attempt < opts.budget.maxCalls) {
    attempt++;

    const systemPrompt = assemble(assembleOpts);

    const callResult = await rawCallClient.rawCall(
      systemPrompt.text,
      userMessage,
      opts.runId,
      opts.taskId,
    );

    if (!callResult.isOk) {
      return callResult;
    }

    const raw = callResult.value;

    const usageCall: UsageCall = buildUsageCall(raw, opts, attempt);
    accumulatedUsage.push(usageCall);

    if (accumulatedUsage.length > opts.budget.maxCalls) {
      break;
    }

    // Step 4: Schema validation
    const planResult = (opts.schema ?? PlanSchema).safeParse(extractPlanFromResponse(raw));
    if (!planResult.success) {
      const schemaErrors = planResult.error.errors.map(
        (e: { path: (string | number)[]; message: string }) => ({
          path: e.path.join('/'),
          code: 'schema_error',
          message: e.message,
        }),
      ) as ValidationError[];

      allErrors.push(...schemaErrors);

      if (attempt >= opts.budget.maxCalls) {
        break;
      }

      const repromptCtx = {
        originalPrompt: opts.sanitizedPrompt,
        previousRawResponse: raw.rawResponse,
        validationErrors: schemaErrors,
        attempt,
      };
      const reprompt = buildRePrompt(repromptCtx, assembleOpts);
      userMessage = reprompt.userMessage;
      continue;
    }

    const plan = planResult.data as Plan;

    // Step 5: Semantic validation
    const semanticContext = {
      ...(opts.workflowContext?.workflowSecrets !== undefined
        ? { workflowSecrets: [...opts.workflowContext.workflowSecrets] }
        : {}),
      ...(opts.workflowContext?.workflowLocators !== undefined
        ? { workflowLocators: [...opts.workflowContext.workflowLocators] }
        : {}),
    };
    const semanticResult = validatePlanSemantics(plan, semanticContext);

    if (!semanticResult.isOk) {
      allErrors.push(...semanticResult.error);

      if (attempt >= opts.budget.maxCalls) {
        break;
      }

      const repromptCtx = {
        originalPrompt: opts.sanitizedPrompt,
        previousRawResponse: raw.rawResponse,
        validationErrors: semanticResult.error,
        attempt,
      };
      const reprompt = buildRePrompt(repromptCtx, assembleOpts);
      userMessage = reprompt.userMessage;
      continue;
    }

    // Step 6: Success — aggregate usage and return
    const aggregatedUsage = aggregateUsage(accumulatedUsage);
    return ok({ plan: semanticResult.value, usage: aggregatedUsage });
  }

  // Budget exhausted or max calls reached without success
  const dominantCode = dominantErrorCode(allErrors);
  const userFacingHint = resolveUserFacingHint(dominantCode);

  if (attempt >= opts.budget.maxCalls && allErrors.length === 0) {
    return err({
      kind: 'llm_budget_exhausted',
      callsMade: attempt,
      maxCalls: opts.budget.maxCalls,
    });
  }

  return err({
    kind: 'llm_validation_failed',
    attempts: attempt,
    errors: allErrors,
    userFacingHint,
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function extractPlanFromResponse(raw: RawCallResult): unknown {
  // pi-agent-core delivers the agent's tool call as structured input.
  // The first tool call's input is the Plan.
  if (raw.toolCalls.length > 0) {
    return raw.toolCalls[0]?.input;
  }
  // Fallback: try to parse rawResponse as JSON
  if (typeof raw.rawResponse === 'string') {
    try {
      return JSON.parse(raw.rawResponse);
    } catch {
      return raw.rawResponse;
    }
  }
  return raw.rawResponse;
}

function buildUsageCall(raw: RawCallResult, _opts: GeneratePlanOpts, _attempt: number): UsageCall {
  return {
    step_id: null,
    model: 'unknown',
    provider: 'anthropic' as const,
    input_tokens: raw.inputTokens,
    output_tokens: raw.outputTokens,
    cost_estimate_usd: null,
    latency_ms: raw.latencyMs,
    at: new Date().toISOString(),
  };
}

function aggregateUsage(calls: UsageCall[]): UsageCall {
  const totalInput = calls.reduce((s, c) => s + c.input_tokens, 0);
  const totalOutput = calls.reduce((s, c) => s + c.output_tokens, 0);
  const totalLatency = calls.reduce((s, c) => s + c.latency_ms, 0);
  const costValues = calls.map((c) => c.cost_estimate_usd).filter((v): v is number => v !== null);
  const cost = costValues.length === calls.length ? costValues.reduce((s, v) => s + v, 0) : null;

  return {
    step_id: null,
    model: calls[0]?.model ?? 'unknown',
    provider: calls[0]?.provider ?? 'anthropic',
    input_tokens: totalInput,
    output_tokens: totalOutput,
    cost_estimate_usd: cost,
    latency_ms: totalLatency,
    at: new Date().toISOString(),
  };
}
