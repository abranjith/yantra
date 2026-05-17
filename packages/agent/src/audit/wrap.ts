import { err } from '@yantra/protocol';
import type { UsageCall } from '@yantra/protocol';
import type { Result } from '@yantra/protocol';

import type {
  AgentAuditWriter,
  AgentUsageWriter,
  GeneratePlanOpts,
  GeneratePlanResult,
  LLMClient,
  LLMError,
  SummarizeOpts,
  SummarizeResult,
} from '../client/interface.js';
import type { AgentJsonlEntry } from '../client/interface.js';

// ---------------------------------------------------------------------------
// Audit HOF
// ---------------------------------------------------------------------------

/**
 * Wraps an LLMClient so every generatePlan and summarize call:
 *  a) Emits an AgentJsonlEntry (direction=request) before the call.
 *  b) Emits an AgentJsonlEntry (direction=response) after — even on error.
 *  c) Appends a UsageCall to usageWriter on every successful provider call.
 *
 * The factory always wraps its returned client — bare provider clients are
 * never exposed outside packages/agent.
 */
export function wrapWithAudit(
  client: LLMClient,
  auditWriter: AgentAuditWriter,
  usageWriter: AgentUsageWriter,
  runId: string,
): LLMClient {
  return new AuditWrappedLLMClient(client, auditWriter, usageWriter, runId);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class AuditWrappedLLMClient implements LLMClient {
  public get providerId(): string {
    return this.inner.providerId;
  }

  public constructor(
    private readonly inner: LLMClient,
    private readonly auditWriter: AgentAuditWriter,
    private readonly usageWriter: AgentUsageWriter,
    private readonly runId: string,
  ) {}

  public async generatePlan(opts: GeneratePlanOpts): Promise<Result<GeneratePlanResult, LLMError>> {
    const ts = new Date().toISOString();
    const promptSanitized = opts.sanitizedPrompt as unknown as string;

    const runId = opts.runId ?? this.runId;
    await this.writeRequest({
      runId,
      taskId: opts.taskId,
      stepId: null,
      promptSanitized,
      attempt: 1,
      ts,
    });

    const start = Date.now();
    let result: Result<GeneratePlanResult, LLMError>;
    try {
      result = await this.inner.generatePlan(opts);
    } catch (thrown) {
      result = err({
        kind: 'llm_provider_error',
        providerCode: null,
        message: String(thrown),
        retryable: false,
      });
    }

    const latencyMs = Date.now() - start;

    if (result.isOk) {
      const { plan, usage } = result.value;
      await this.writeResponse({
        runId,
        taskId: opts.taskId,
        stepId: null,
        response: plan,
        toolCalls: [],
        latencyMs,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costEstimateUsd: usage.cost_estimate_usd,
        attempt: 1,
        outcome: 'ok',
        ts: new Date().toISOString(),
      });
      await this.usageWriter.append(usage);
    } else {
      const outcome = llmErrorToOutcome(result.error);
      await this.writeResponse({
        runId,
        taskId: opts.taskId,
        stepId: null,
        response: null,
        toolCalls: [],
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        costEstimateUsd: null,
        attempt: 1,
        outcome,
        ts: new Date().toISOString(),
      });
    }

    return result;
  }

  public async summarize(opts: SummarizeOpts): Promise<Result<SummarizeResult, LLMError>> {
    const ts = new Date().toISOString();
    const promptSanitized = opts.sanitizedPrompt as unknown as string;

    const runId = opts.runId ?? this.runId;
    await this.writeRequest({
      runId,
      taskId: opts.taskId,
      stepId: opts.stepId ?? null,
      promptSanitized,
      attempt: 1,
      ts,
    });

    const start = Date.now();
    let result: Result<SummarizeResult, LLMError>;
    try {
      result = await this.inner.summarize(opts);
    } catch (thrown) {
      result = err({
        kind: 'llm_provider_error',
        providerCode: null,
        message: String(thrown),
        retryable: false,
      });
    }

    const latencyMs = Date.now() - start;

    if (result.isOk) {
      const { text, usage } = result.value;
      await this.writeResponse({
        runId,
        taskId: opts.taskId,
        stepId: opts.stepId ?? null,
        response: text,
        toolCalls: [],
        latencyMs,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costEstimateUsd: usage.cost_estimate_usd,
        attempt: 1,
        outcome: 'ok',
        ts: new Date().toISOString(),
      });
      await this.usageWriter.append(usage);
    } else {
      const outcome = llmErrorToOutcome(result.error);
      await this.writeResponse({
        runId,
        taskId: opts.taskId,
        stepId: opts.stepId ?? null,
        response: null,
        toolCalls: [],
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        costEstimateUsd: null,
        attempt: 1,
        outcome,
        ts: new Date().toISOString(),
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async writeRequest(opts: {
    runId: string;
    taskId: string;
    stepId: string | null;
    promptSanitized: string;
    attempt: number;
    ts: string;
  }): Promise<void> {
    const entry: AgentJsonlEntry = {
      direction: 'request',
      run_id: opts.runId,
      task_id: opts.taskId,
      provider_id: this.inner.providerId,
      model: '',
      prompt_sanitized: opts.promptSanitized,
      system_prompt_hash: '',
      response: null,
      tool_calls: [],
      latency_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      cost_estimate_usd: null,
      step_id: opts.stepId,
      attempt: opts.attempt,
      outcome: 'ok',
      ts: opts.ts,
    };
    await this.auditWriter.appendAgentCall(entry);
  }

  private async writeResponse(opts: {
    runId: string;
    taskId: string;
    stepId: string | null;
    response: unknown;
    toolCalls: readonly { tool: string; input: unknown }[];
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costEstimateUsd: number | null;
    attempt: number;
    outcome: AgentJsonlEntry['outcome'];
    ts: string;
  }): Promise<void> {
    const entry: AgentJsonlEntry = {
      direction: 'response',
      run_id: opts.runId,
      task_id: opts.taskId,
      provider_id: this.inner.providerId,
      model: '',
      prompt_sanitized: '',
      system_prompt_hash: '',
      response: opts.response,
      tool_calls: opts.toolCalls,
      latency_ms: opts.latencyMs,
      input_tokens: opts.inputTokens,
      output_tokens: opts.outputTokens,
      cost_estimate_usd: opts.costEstimateUsd,
      step_id: opts.stepId,
      attempt: opts.attempt,
      outcome: opts.outcome,
      ts: opts.ts,
    };
    await this.auditWriter.appendAgentCall(entry);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function llmErrorToOutcome(error: LLMError): AgentJsonlEntry['outcome'] {
  switch (error.kind) {
    case 'llm_timeout':
      return 'timeout';
    case 'llm_validation_failed':
      return 'validation_failed';
    case 'llm_unavailable':
    case 'llm_provider_error':
    case 'llm_budget_exhausted':
      return 'provider_error';
  }
}

// ---------------------------------------------------------------------------
// In-memory implementations for testing
// ---------------------------------------------------------------------------

export class InMemoryAuditWriter implements AgentAuditWriter {
  public readonly entries: AgentJsonlEntry[] = [];

  public appendAgentCall(entry: AgentJsonlEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

export class InMemoryUsageWriter implements AgentUsageWriter {
  public readonly calls: UsageCall[] = [];

  public append(call: UsageCall): Promise<void> {
    this.calls.push(call);
    return Promise.resolve();
  }
}
