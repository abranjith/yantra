/**
 * In-memory types for the workflow replay feature (FEAT-010).
 *
 * These types describe the lifecycle of a single `Run` — from `RunRequest`
 * through `RunManifest` on disk to the final `OrchestratorRunOutcome`.
 */

import type {
  AgentManifestSection,
  Brief,
  FailureClass,
  Plan,
  WorkflowSynthesis,
} from '@yantra/protocol';

import type { ProfileSpec } from '../../browser/types.js';
import type { Checkpoint } from '../../executor/types.js';
import type { EngineLocatorChain } from '../../locator/types.js';

export type { FailureClass };

// ---------------------------------------------------------------------------
// Run request (constructed by CLI from argv)
// ---------------------------------------------------------------------------

/** A single CLI param key=value pair before type coercion. */
export interface ParamArg {
  readonly key: string;
  readonly rawValue: string;
}

/** Declared workflow params spec from `workflow.params`. */
export type WorkflowParamsSpec = Record<
  string,
  { type: 'string' | 'number' | 'boolean' | 'date'; required: boolean; example: string | null }
>;

/** Budget overrides provided by the CLI caller. */
export interface RunBudgets {
  readonly stepRetries?: number;
  readonly wallClockMs?: number;
  readonly humanWaitMs?: number;
}

/** Top-level request constructed by the CLI from argv. */
export interface RunRequest {
  readonly workflowName: string;
  /** Resolved (coerced) param values. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Optional path to a YAML/JSON param file (loaded by params-resolver). */
  readonly paramsFile?: string;
  readonly budgets: RunBudgets;
  readonly json: boolean;
  readonly debug: boolean;
}

// ---------------------------------------------------------------------------
// Run status
// ---------------------------------------------------------------------------

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted' | 'paused';

// ---------------------------------------------------------------------------
// Failure detail
// ---------------------------------------------------------------------------

export interface FailureDetail {
  failureClass: FailureClass;
  stepId: string;
  message: string;
  locatorName?: string;
}

// ---------------------------------------------------------------------------
// Orchestrator RunOutcome (distinct from executor's RunOutcome)
// ---------------------------------------------------------------------------

/** On-disk locations of a run's Brief artifacts. */
export interface BriefRunArtifacts {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly htmlPath: string;
}

/** Provenance of one Synthesize stage, recorded in `manifest.json`. */
export interface RunSynthesisRecord {
  /** Which strategy actually produced the Brief. */
  readonly strategy: 'deterministic' | 'llm';
  /** True when the LLM path failed and the deterministic strategy took over. */
  readonly fallbackUsed: boolean;
  /** Path of `brief.json`, or null when the artifact write failed. */
  readonly briefPath: string | null;
}

/** Non-secret template provenance recorded for an agentic report run. */
export interface RunTemplateRecord {
  readonly name: string | null;
  readonly hash: string;
  readonly source: 'saved' | 'path';
}

/** Returned by RunOrchestrator.run() — the CLI maps these to exit codes. */
export type OrchestratorRunOutcome =
  | {
      readonly kind: 'success';
      readonly runId: string;
      readonly outputs: Readonly<Record<string, unknown>>;
      /**
       * Paths of the Brief artifacts the Synthesize stage wrote (FEAT-FP-001),
       * present only when the workflow declared `synthesis:` and the stage
       * succeeded. Absent is normal — synthesis is opt-in and best-effort.
       */
      readonly brief?: BriefRunArtifacts;
    }
  | {
      readonly kind: 'failure';
      readonly runId: string;
      readonly failureClass: FailureClass;
      readonly failureDetail: FailureDetail;
    }
  | {
      readonly kind: 'aborted';
      readonly runId: string;
      readonly reason: 'user-handoff' | 'user-abort' | 'scope-violation' | 'ethics-refused';
    };

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * Rehydrated state consumed by `RunOrchestrator.resume`.
 * A checkpoint is a LOGICAL POINTER — not a browser-state snapshot.
 */
export interface ResumePoint {
  readonly runId: string;
  readonly runDir: string;
  readonly workflowName: string;
  readonly plan: Plan;
  readonly nextStepIndex: number;
  readonly lastCheckpoint: Checkpoint | null;
  readonly manifest: RunManifest;
  readonly profileKind: 'workflow' | 'ephemeral' | 'explicit';
  readonly cookieProfilePath: string | null;
}

// ---------------------------------------------------------------------------
// Workflow → Plan translation output
// ---------------------------------------------------------------------------

/** Table of named locator chains derived from workflow._locators. */
export type LocatorTable = Record<string, EngineLocatorChain>;

/** Output binding with JSONata expression and retention policy. */
export interface OutputBinding {
  readonly name: string;
  readonly expression: string;
  readonly retention: 'transient' | 'persisted';
}

/** Full output of the Workflow → Plan translator. */
export interface TranslatedWorkflow {
  readonly plan: Plan;
  readonly locatorTable: LocatorTable;
  readonly profileSpec: ProfileSpec;
  readonly outputBindings: readonly OutputBinding[];
  readonly declaredSecretKeys: readonly string[];
  /**
   * The workflow's declared synthesis intent, or null when it declares none
   * (FEAT-FP-001). Carried through translation because the Synthesize stage runs
   * after the executor, by which point the `WorkflowFile` is out of scope.
   */
  readonly synthesisSpec: WorkflowSynthesis | null;
}

// ---------------------------------------------------------------------------
// Output evaluator result
// ---------------------------------------------------------------------------

export interface EvaluatedOutputs {
  readonly persisted: Readonly<Record<string, unknown>>;
  readonly transient: Readonly<Record<string, unknown>>;
  readonly errors: readonly { name: string; error: string }[];
}

// ---------------------------------------------------------------------------
// On-disk artifacts
// ---------------------------------------------------------------------------

/** Serialized to manifest.json. Secrets and PII never appear. */
export interface RunManifest {
  runId: string;
  taskId: string;
  workflowName: string;
  workflowVersion: number | null;
  params: Readonly<Record<string, unknown>>;
  startedAt: string;
  endedAt: string | undefined;
  status: RunStatus;
  durationMs: number | undefined;
  failureClass: FailureClass | undefined;
  profileKind: 'workflow' | 'ephemeral' | 'explicit';
  cookieProfilePath: string | null;
  outputBindingNames: readonly string[];
  chromeDriftWarning: { recorded: number; current: number } | undefined;
  /** Distinguishes direct agentic runs from deterministic workflow replay. */
  runKind?: 'workflow' | 'agentic';
  /** Partial during startup; complete and schema-valid after the session opens. */
  agent?: Partial<AgentManifestSection>;
  /** Typed, render-safe startup failure when the provider session never opened. */
  agentError?: AgentStartupFailureRecord;
  /**
   * Synthesize-stage provenance (FEAT-FP-001). Present only when the workflow
   * declared `synthesis:` and the stage ran, so `resume` can inherit the
   * original run's strategy instead of silently changing it.
   */
  synthesis?: RunSynthesisRecord;
  /** Active report-template revision, when the agent published `document.*`. */
  template?: RunTemplateRecord;
}

/** Stable agent startup codes persisted without importing the agent package into core. */
export type AgentStartupFailureCode =
  | 'AGENT_MODEL_NOT_FOUND'
  | 'AGENT_AUTH_UNAVAILABLE'
  | 'AGENT_PROVIDER_UNAVAILABLE'
  | 'AGENT_SESSION_START_FAILED'
  | 'AGENT_ABORTED';

/** Typed and sanitized startup failure stored in `manifest.json`. */
export interface AgentStartupFailure {
  readonly code: AgentStartupFailureCode;
  readonly message: string;
}

/** Persisted startup failure plus its terminal timestamp. */
export interface AgentStartupFailureRecord extends AgentStartupFailure {
  readonly at: string;
}

/** Minimum metadata needed to create an agentic run before provider validation. */
export interface AgentRunRequest {
  readonly taskId: string;
  readonly command: string;
  readonly partialAgent?: Partial<AgentManifestSection>;
  readonly template?: RunTemplateRecord;
}

/** Run-store operations used by agentic commands before and during startup. */
export interface AgentRunStore {
  createAgentRun(request: AgentRunRequest): Promise<{ runId: string; runDir: string }>;
  finalizeStartupFailure(runId: string, error: AgentStartupFailure): Promise<void>;
}

/** Serialized to outputs.json. */
export interface RunOutputs {
  readonly runId: string;
  readonly workflowName: string;
  readonly createdAt: string;
  readonly outputs: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Run summary (for listRuns)
// ---------------------------------------------------------------------------

export interface RunSummary {
  readonly runId: string;
  readonly workflowName: string;
  readonly workflowVersion: number | null;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly durationMs: number | undefined;
  readonly failureClass: FailureClass | undefined;
}

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface StepLogEntry {
  readonly stepId: string;
  readonly type: string;
  readonly status: 'ok' | 'failed';
  readonly durationMs?: number;
  readonly error?: string;
}

export interface RunReport {
  readonly manifest: RunManifest;
  readonly stepLog: readonly StepLogEntry[];
  readonly outputs?: EvaluatedOutputs;
  readonly failure?: FailureDetail;
  readonly auditEntries: readonly Record<string, unknown>[];
  /**
   * The Brief the Synthesize stage produced, when it ran (FEAT-FP-001). The
   * report shows its title, overview, and sources so `report.md` is readable
   * without opening `brief.md`.
   */
  readonly brief?: Brief;
}

export interface RunJsonSummary {
  readonly runId: string;
  readonly workflowName: string;
  readonly status: RunStatus;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly durationMs: number | undefined;
  readonly stepCount: number;
  readonly failedSteps: number;
  readonly failureClass: FailureClass | undefined;
  readonly outputs: readonly string[];
  /** Synthesize-stage provenance, present only when the stage produced a Brief. */
  readonly synthesis?: RunSynthesisRecord;
}

// ---------------------------------------------------------------------------
// Preflight result
// ---------------------------------------------------------------------------

export interface PreflightResult {
  readonly ok: true;
}

// ---------------------------------------------------------------------------
// Store interfaces
// ---------------------------------------------------------------------------

export interface RunStore {
  createRun(request: RunRequest): Promise<{ runId: string; runDir: string }>;
  listRuns(opts?: {
    workflowName?: string;
    status?: RunStatus;
    limit?: number;
  }): Promise<readonly RunSummary[]>;
  getRun(runId: string): Promise<{ manifest: RunManifest; runDir: string } | null>;
  updateRunStatus(
    runId: string,
    patch: {
      status: RunStatus;
      endedAt?: string;
      failureClass?: FailureClass;
      lastCheckpointStepId?: string;
    },
  ): Promise<void>;
  releaseLock(runId: string): Promise<void>;
}
