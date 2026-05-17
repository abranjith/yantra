import type { Plan, Result, ToolCatalog, UsageCall, ValidationError } from '@yantra/protocol';
import type { ZodSchema } from 'zod';

import type { Sanitized } from '../sanitizer-guard.js';

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface LLMBudget {
  /** Hard cap on LLM calls inside a single generatePlan invocation (re-prompts count). */
  readonly maxCalls: number;
  /** Per-call timeout in milliseconds. */
  readonly maxLatencyMs: number;
  /** Input token limit; null = provider default. */
  readonly maxTokensIn: number | null;
  /** Output token limit; null = provider default. */
  readonly maxTokensOut: number | null;
}

export const DEFAULT_BUDGET: LLMBudget = {
  maxCalls: 3,
  maxLatencyMs: 60_000,
  maxTokensIn: null,
  maxTokensOut: null,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GeneratePlanOpts {
  readonly sanitizedPrompt: Sanitized<string>;
  readonly toolCatalog: ToolCatalog;
  readonly schema: ZodSchema;
  readonly budget: LLMBudget;
  readonly workflowContext?: {
    readonly workflowSecrets?: readonly string[];
    readonly workflowLocators?: readonly string[];
  };
  readonly runId: string;
  readonly taskId: string;
}

export interface SummarizeOpts {
  readonly sanitizedInput: Sanitized<string>;
  readonly sanitizedPrompt: Sanitized<string>;
  readonly budget: LLMBudget;
  readonly runId: string;
  readonly taskId: string;
  readonly stepId?: string | null;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface GeneratePlanResult {
  readonly plan: Plan;
  /** Aggregated usage across all re-prompt attempts. */
  readonly usage: UsageCall;
}

export interface SummarizeResult {
  readonly text: string;
  readonly usage: UsageCall;
}

// ---------------------------------------------------------------------------
// LLMError discriminated union
// ---------------------------------------------------------------------------

export type LLMError =
  | {
      readonly kind: 'llm_unavailable';
      readonly reason: 'provider_none' | 'missing_api_key' | 'ollama_unreachable';
      readonly hint: string;
    }
  | {
      readonly kind: 'llm_timeout';
      readonly elapsedMs: number;
      readonly budgetMs: number;
    }
  | {
      readonly kind: 'llm_provider_error';
      readonly providerCode: string | null;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly kind: 'llm_validation_failed';
      readonly attempts: number;
      readonly errors: readonly ValidationError[];
      readonly userFacingHint: string;
    }
  | {
      readonly kind: 'llm_budget_exhausted';
      readonly callsMade: number;
      readonly maxCalls: number;
    };

// ---------------------------------------------------------------------------
// Audit entry written to agent.jsonl per call
// ---------------------------------------------------------------------------

export interface AgentJsonlEntry {
  readonly direction: 'request' | 'response';
  readonly run_id: string;
  readonly task_id: string;
  readonly provider_id: string;
  readonly model: string;
  readonly prompt_sanitized: string;
  readonly system_prompt_hash: string;
  readonly response: unknown;
  readonly tool_calls: readonly { tool: string; input: unknown }[];
  readonly latency_ms: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cost_estimate_usd: number | null;
  readonly step_id: string | null;
  readonly attempt: number;
  readonly outcome: 'ok' | 'validation_failed' | 'timeout' | 'provider_error';
  readonly ts: string;
}

// ---------------------------------------------------------------------------
// AuditLogWriter interface (subset needed by this package — injected at factory)
// ---------------------------------------------------------------------------

export interface AgentAuditWriter {
  appendAgentCall(entry: AgentJsonlEntry): Promise<void>;
}

// ---------------------------------------------------------------------------
// UsageWriter interface (injected at factory — avoids @yantra/core dep)
// ---------------------------------------------------------------------------

export interface AgentUsageWriter {
  append(call: UsageCall): Promise<void>;
}

// ---------------------------------------------------------------------------
// LLMClient strategy interface
// ---------------------------------------------------------------------------

export interface LLMClient {
  /**
   * Generate a Plan from a sanitized user intent.
   * Runs schema + semantic validation with bounded re-prompt on failure.
   */
  generatePlan(opts: GeneratePlanOpts): Promise<Result<GeneratePlanResult, LLMError>>;

  /**
   * Free-form summarization over already-sanitized input.
   * Used by ask's LLM synthesis path and by llm_summarize step handler.
   */
  summarize(opts: SummarizeOpts): Promise<Result<SummarizeResult, LLMError>>;

  /** Identity string for logging; e.g., "anthropic:claude-sonnet-4-6", "null". */
  readonly providerId: string;
}
