/** Public agent surface: provider seam, runtime, and typed agent errors. */
export type {
  AgentAuthSelection,
  AgentError,
  AgentEvent,
  AgentModelSelection,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionOptions,
  AgentUsage,
} from './provider/index.js';

export { PiAgentProvider } from './adapters/pi/provider.js';
export type { PiAgentProviderOptions } from './adapters/pi/provider.js';
export { AGENT_SMOKE_PROMPT_VERSION, runAgentSmoke } from './adapters/pi/smoke.js';
export type { AgentSmokeOptions, AgentSmokeReport } from './adapters/pi/smoke.js';
export {
  buildYantraWrappedTools,
  browserClickSpec,
  browserExtractSpec,
  browserFillElementSpec,
  browserFillFormSpec,
  browserNavigateSpec,
  browserObserveSpec,
  browserScreenshotSpec,
  createBriefPublisher,
  createTemplatedReportPublisher,
  createYantraTools,
  resultPublishSpec,
  scriptRunSpec,
  templateParamsFor,
  validateSlots,
  webFetchSpec,
  webSearchSpec,
  yantraToolCatalog,
} from './adapters/pi/tools/index.js';

export { SYNTHESIS_PROMPT_VERSION, YANTRA_SYNTHESIS_PROMPT } from './synthesis/prompt.js';
export type {
  SynthesisPromptDetail,
  SynthesisPromptIssue,
  SynthesisPromptLength,
  SynthesisPromptSourceInput,
  SynthesisUserPromptInput,
} from './synthesis/prompt.js';

export {
  AgentAbortedError,
  AgentAuthUnavailableError,
  AgentModelNotFoundError,
  AgentProviderUnavailableError,
  AgentSessionStartFailedError,
  AgentStartupError,
} from './errors.js';
export type { AgentStartupErrorCode } from './errors.js';

export * from './runtime/index.js';

export const AGENT_PROTOCOL_VERSION = '0.0.1' as const;
export type AgentProtocolVersion = typeof AGENT_PROTOCOL_VERSION;
