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
// Synthesis prompt template (FEAT-014) — plain data injected into core's
// LlmSynthesizer at wiring time (core cannot import agent).
// ---------------------------------------------------------------------------
export { SYNTHESIS_PROMPT } from './synthesis/prompt.js';
export type {
  SynthesisPromptInput,
  SynthesisPromptSource,
  SynthesisPromptTemplate,
} from './synthesis/prompt.js';

// ---------------------------------------------------------------------------
// Research follow-up-query prompt template (FEAT-017) — plain data injected
// into core's FollowUpQueryGenerator at wiring time.
// ---------------------------------------------------------------------------
export { RESEARCH_QUERY_PROMPT } from './research/prompt.js';
export type { ResearchQueryPromptInput, ResearchQueryPromptTemplate } from './research/prompt.js';

// ---------------------------------------------------------------------------
// Plan generation
// ---------------------------------------------------------------------------
export { runGeneratePlan } from './plan/generate.js';
export type { RawCallClient, RawCallResult } from './plan/generate.js';

// ---------------------------------------------------------------------------
// Discovery mode (FEAT-020) — proposer, prompt template, session-state reducer
// ---------------------------------------------------------------------------
export { DISCOVERY_PROMPT } from './discovery/prompts.js';
export type {
  DiscoveryPromptCycle,
  DiscoveryPromptCycleOneLine,
  DiscoveryPromptCycleSummary,
  DiscoveryPromptInput,
  DiscoveryPromptTemplate,
} from './discovery/prompts.js';
export {
  DEFAULT_MAX_REPROMPTS as DISCOVERY_DEFAULT_MAX_REPROMPTS,
  propose,
} from './discovery/propose.js';
export type { ProposeDeps, ProposeError, ProposeOpts } from './discovery/propose.js';
export {
  appendCycle,
  expandAllowlist,
  initDiscoveryState,
  latestBudgetSnapshot,
  latestObservation,
  trimHistoryForPrompt,
  ZERO_BUDGET_SNAPSHOT,
} from './discovery/session-state.js';
export type { DiscoverySessionState } from './discovery/session-state.js';

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
