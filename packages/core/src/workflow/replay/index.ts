/**
 * Workflow Replay module — public API barrel.
 *
 * Everything a consumer (CLI, agent, test) needs to orchestrate workflow runs.
 */

// Core types
export type {
  AgentRunRequest,
  AgentRunStore,
  AgentStartupFailure,
  AgentStartupFailureCode,
  AgentStartupFailureRecord,
  BriefRunArtifacts,
  EvaluatedOutputs,
  FailureDetail,
  LocatorTable,
  OrchestratorRunOutcome,
  OutputBinding,
  ParamArg,
  PreflightResult,
  ResumePoint,
  RunBudgets,
  RunJsonSummary,
  RunManifest,
  RunOutputs,
  RunReport,
  RunRequest,
  RunStatus,
  RunStore,
  RunSummary,
  RunSynthesisRecord,
  TranslatedWorkflow,
  WorkflowParamsSpec,
} from './types.js';

// Synthesize stage (FEAT-FP-001)
export { runSynthesizeStage, synthesizeGate, synthesizeRun } from './synthesize.js';
export type {
  SynthesisRunContext,
  SynthesisSpec,
  SynthesisStrategies,
  SynthesizeGate,
  SynthesizeGateInput,
  SynthesizeRunOptions,
  SynthesizeStageResult,
} from './synthesize.js';

// Errors
export {
  MissingRequiredParamError,
  ParamsValidationError,
  RunDirMissingError,
  RunDirLockedError,
  RunNotResumableError,
  WorkflowNotFoundError,
  WorkflowTranslationError,
} from './errors.js';
export type { OutputEvaluationError } from './errors.js';

// Orchestrator + exit codes
export { RunOrchestrator, exitCodeFor } from './run-orchestrator.js';
export type { RunOrchestratorOptions } from './run-orchestrator.js';

// Run store + run-id formatting
export { LocalRunStore, formatRunId } from './run-store.js';
export { readManifest, writeManifest } from './manifest-writer.js';

// Params resolver
export { resolveParams } from './params-resolver.js';

// Cookie mode → ProfileSpec
export { cookieModeToProfileSpec } from './cookies-mode.js';

// Workflow → Plan translator
export { translate } from './workflow-to-plan.js';

// Preflight checks
export {
  EthicsPreflightError,
  SecretsMissingError,
  WorkflowLintError,
  preflightEthics,
  preflightSecrets,
  preflightWorkflow,
} from './preflight.js';

// Output evaluator
export { evaluateOutputs, redactOutputsForDisk } from './output-evaluator.js';

// Report renderer
export { MarkdownReportRenderer, renderJsonSummary, renderRunReport } from './report-renderer.js';

// Resume helpers
export { loadResumePoint, requiresUserConsent } from './resume.js';

// Chrome drift + frame diagnostic
export { checkChromeDrift } from './chrome-drift.js';
export type { ChromeDriftResult } from './chrome-drift.js';
export { diagnoseLocatorMiss } from './frame-diagnostic.js';
