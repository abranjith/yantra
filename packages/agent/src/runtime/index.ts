export {
  canonicalJson,
  hashToolCatalog,
  sha256Text,
  type HashableToolDefinition,
} from './catalog-hash.js';
export {
  RunRecorder,
  resolvePiSdkVersion,
  resolveYantraVersion,
  type RunRecorderOptions,
} from './run-recorder.js';
export {
  AGENT_SYSTEM_PROMPT,
  PROMPT_VERSION,
  buildAgentUserPrompt,
  type AgentAmbientContext,
  type AgentPromptBudgets,
  type AgentUserPromptInput,
} from './prompt.js';
export { UrlProvenance } from './url-provenance.js';
export { RunHealthLedger, type ToolOutcomeRecord, type ToolOutcomeStatus } from './run-health.js';
export {
  resolveVisionAvailability,
  type ModelVisionCapability,
  type VisionAvailability,
  type VisionAvailabilityInput,
  type VisionReason,
} from './vision.js';
export {
  captureCapabilityRecord,
  resolveCaptureCapability,
  type CaptureCapability,
  type CaptureCapabilityInput,
  type DeliverableReason,
} from './capture-capability.js';
export {
  locationHandoffFor,
  requiresUserLocation,
  type AmbientContextView,
  type LocationHandoff,
} from './location-gate.js';
export {
  ConfirmationBridge,
  ConfirmationWaitAbortedError,
  type ConfirmationBridgeOptions,
  type ConfirmationConnector,
} from './confirmation-bridge.js';
export {
  TASK_OUTCOME_TABLE,
  exitCodeForAgenticOutcome,
  failureClassFor,
  outcomeFirstLine,
  outcomeSummary,
  taskOutcomeOf,
  type AgenticTaskOutcome,
  type PromotionResult,
  type PublishedBriefRef,
  type RequirementsSummary,
  type TaskOutcomeMapping,
  type UnmetRequirement,
} from './outcome.js';
export type { AgentProgressEvent, AgentTaskConnector } from './connector.js';
export {
  DEFAULT_AGENT_BUDGETS,
  defaultEnvironmentLeaves,
  isRunFatalBudget,
  runAgenticTask,
  type EnvironmentLeaves,
  type AgentBudgetConfig,
  type ActiveReportTemplate,
  type AgenticRunEnvironment,
  type AgenticRunStore,
  type AgenticTaskDependencies,
  type AgenticTaskRequest,
} from './orchestrator.js';
export {
  CONTRACT_FILE,
  MISSING_CONTRACT_REASON,
  NO_ACTION_TERMS,
  TaskContractStore,
  effectiveActionTermsOf,
  hostSatisfiesRequiredSource,
  normalizeContract,
  normalizeSourceHost,
  renderActionPhrase,
  renderContractEcho,
  type ContractIssue,
  type EffectiveActionTerms,
  type TaskContractParams,
  type TaskContractStoreOptions,
} from './task-contract.js';
export {
  ActionLedger,
  actionLedgerFor,
  type ActionLedgerEntry,
  type ActionLedgerInput,
  type CaptureEntry,
  type ClickExecutedEntry,
  type CommittedActionEntry,
  type FillCommittedEntry,
  type SubmitRefusedEntry,
} from './action-ledger.js';
export {
  FulfillmentRecord,
  evaluateFulfillment,
  fillCoverage,
  fulfillmentSummary,
  toBriefRequirements,
  unmetPhrase,
  type FulfillmentEvaluation,
  type FulfillmentInput,
  type FillCoverage,
  type RequirementStatus,
} from './fulfillment.js';
export {
  visionContractCapabilities,
  type CaptureGapReason,
  type ContractCapabilityResolver,
} from './contract-capabilities.js';
export {
  COMMAND_TASK_PROFILES,
  browserCapabilityOf,
  promptAddendumFor,
  resolveCommandTaskProfile,
  type AgenticCommand,
  type BriefKind,
  type BrowserCapability,
  type CommandTaskProfile,
  type CommandTaskProfileOptions,
  type WorkflowToolMode,
  type YantraToolName,
} from './profiles.js';
export {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  probeAgentCredential,
  runAgentDiagnostics,
  type AgentCredentialProbeInput,
  type AgentDiagnosticDependencies,
  type AgentDiagnosticOptions,
  type AgentDoctorCheck,
  type AgentOptionSource,
} from './diagnostics.js';

// ---------------------------------------------------------------------------
// FEAT-024 tool runtime — budgets, outbound URL policy, mandatory middleware,
// and the per-run services bundle. Provider-neutral (no Pi SDK import).
// ---------------------------------------------------------------------------
export {
  BudgetTracker,
  DEFAULT_BUDGET_LIMITS,
  type BudgetDecision,
  type BudgetLimit,
  type BudgetLimits,
  type BudgetSnapshot,
  type NowMs,
} from './budget.js';
export {
  DEFAULT_URL_POLICY_CONFIG,
  UrlPolicy,
  type AllowedUrl,
  type UrlAuditRecord,
  type UrlAuditSink,
  type UrlPolicyConfig,
  type UrlPolicyErrorCode,
  type UrlPolicyRejection,
} from './url-policy.js';
export {
  wrapTool,
  type ConfirmationSpec,
  type DomainContext,
  type DomainFailure,
  type DomainResult,
  type DomainSuccess,
  type PolicyContext,
  type ToolStatus,
  type ToolWrapperSpec,
  type WrappedTool,
  type YantraToolResult,
  type YantraToolContent,
} from './middleware.js';
export {
  AgentTrace,
  AgentTraceFileSchema,
  toCandidateChain,
  type AgentTraceStep,
  type AgentTraceFile,
  type TraceFillValue,
} from './trace.js';
export { AGENT_INTERACTION_MESSAGES, renderAgentMessage } from './messages.js';
export {
  ActionPhase,
  EvidenceLedger,
  EvidencePhase,
  type EvidenceEntry,
  type ConfirmationServices,
  type FetchToolDeps,
  type PublishOutcome,
  type PublishToolDeps,
  type PublishValidationError,
  type RunServices,
  type ScriptExecutorLike,
  type ScriptRunOutcome,
  type ScriptToolDeps,
  type SearchToolDeps,
  type ToolDomainDeps,
  type BrowserToolDeps,
  type WorkflowToolDeps,
  type WorkflowRunInput,
  type WorkflowRunContext,
  type WorkflowRunToolOutcome,
} from './run-services.js';
