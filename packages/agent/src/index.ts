// ---------------------------------------------------------------------------
// LLMClient strategy interface + supporting types
// ---------------------------------------------------------------------------
export type {
  AgentAuditWriter,
  AgentJsonlEntry,
  AgentUsageWriter,
  GeneratePlanOpts,
  GeneratePlanResult,
  LLMBudget,
  LLMClient,
  LLMError,
  SummarizeOpts,
  SummarizeResult,
} from './client/interface.js';
export { DEFAULT_BUDGET } from './client/interface.js';

// ---------------------------------------------------------------------------
// Factory + provider config
// ---------------------------------------------------------------------------
export { createLLMClient } from './client/factory.js';
export type { LLMClientDeps, ProviderConfig, ProviderName } from './client/factory.js';

// ---------------------------------------------------------------------------
// Concrete clients
// ---------------------------------------------------------------------------
export { AnthropicLLMClient } from './client/anthropic.js';
export type { AnthropicLLMClientOptions } from './client/anthropic.js';
export { NullLLMClient } from './client/null.js';
export { OllamaLLMClient } from './client/ollama.js';
export type { OllamaLLMClientOptions } from './client/ollama.js';
export { RecordingLLMClient } from './client/recording.js';
export type { GoldenFixture } from './client/recording.js';

// ---------------------------------------------------------------------------
// Sanitizer guard
// ---------------------------------------------------------------------------
export type { Sanitized } from './sanitizer-guard.js';
export { assertSanitized, brandSanitized } from './sanitizer-guard.js';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------
export {
  LLMBudgetExhaustedError,
  LLMProviderError,
  LLMTimeoutError,
  LLMUnavailableError,
  LLMValidationFailedError,
  SanitizerGuardError,
} from './errors.js';

// ---------------------------------------------------------------------------
// Audit wrapper + in-memory test helpers
// ---------------------------------------------------------------------------
export { InMemoryAuditWriter, InMemoryUsageWriter, wrapWithAudit } from './audit/wrap.js';

// ---------------------------------------------------------------------------
// System prompt assembly
// ---------------------------------------------------------------------------
export { assemble, assembleSummarize } from './prompts/assemble.js';
export type { AssembleOpts, SystemPromptAssembly } from './prompts/assemble.js';

// ---------------------------------------------------------------------------
// Re-prompt builder
// ---------------------------------------------------------------------------
export { buildRePrompt } from './prompts/reprompt.js';
export type { RePromptContext } from './prompts/reprompt.js';

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------
export { runGeneratePlan } from './plan/generate.js';
export type { RawCallClient, RawCallResult } from './plan/generate.js';

// ---------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------
export { validatePlanSemantics } from './plan/validate.js';

// ---------------------------------------------------------------------------
// User-facing hints
// ---------------------------------------------------------------------------
export {
  dominantErrorCode,
  resolveUserFacingHint,
  USER_FACING_HINTS,
} from './plan/user-facing-hints.js';

// ---------------------------------------------------------------------------
// pi-adapter (only file that knows pi-agent-core's tool-definition shape)
// ---------------------------------------------------------------------------
export { createEventSink, toolCatalogToAgentTools } from './client/pi-adapter.js';
export type { AuditEventSink, ExecuteHooks } from './client/pi-adapter.js';

// ---------------------------------------------------------------------------
// Pricing table
// ---------------------------------------------------------------------------
export { estimateCostUsd } from './client/pricing.js';

// ---------------------------------------------------------------------------
// Version constant — used by `yantra --version` and smoke tests.
// ---------------------------------------------------------------------------
export const AGENT_PROTOCOL_VERSION = '0.0.0' as const;
export type AgentProtocolVersion = typeof AGENT_PROTOCOL_VERSION;
