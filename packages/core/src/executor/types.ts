import type { ElementHandle } from 'puppeteer-core';

import type {
  CaptureRef,
  ExtractionResultEnvelopeUnknown,
  FailureClass,
  HandoffReason,
  Plan,
  SecurityScope,
  SecretRef,
  Step,
  TaskEvent,
  UsageCall,
} from '@yantra/protocol';

import type { BrowserSession, Logger, Page } from '../browser/types.js';
import type { EngineLocatorChain, InjectedScriptHost } from '../locator/types.js';

// ---------------------------------------------------------------------------
// Clock abstraction for testability
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(handle: ReturnType<typeof globalThis.setTimeout>): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

// ---------------------------------------------------------------------------
// Stub interfaces for parallel-development dependencies (FEAT-006, FEAT-011)
// ---------------------------------------------------------------------------

/** Resolves SecretRef to a plaintext string. Implemented in FEAT-006. */
export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}

/** Sanitizes payloads before LLM submission. Implemented in FEAT-006. */
export interface Sanitizer {
  sanitize(payload: unknown, securityClass: SecurityScope): unknown;
}

/** Sends content to the LLM. Implemented in FEAT-011. */
export interface LLMClient {
  summarize(
    input: unknown,
    prompt: string,
  ): Promise<{
    text: string;
    usage: Omit<UsageCall, 'step_id' | 'at'>;
  }>;
}

/** Resolves workflow locator names to EngineLocatorChain. Implemented in FEAT-010. */
export interface WorkflowLocatorStore {
  resolve(name: string): EngineLocatorChain | null;
}

// ---------------------------------------------------------------------------
// CaptureStore
// ---------------------------------------------------------------------------

export interface CaptureSnapshot {
  readonly entries: Record<string, unknown>;
  readonly sidecars: Record<string, string>;
}

export interface CaptureStore {
  get(name: string): unknown | undefined;
  set(name: string, value: unknown): void;
  has(name: string): boolean;
  keys(): string[];
  snapshot(opts?: { inlineLimitBytes?: number }): CaptureSnapshot;
  restore(snapshot: CaptureSnapshot): void;
}

// ---------------------------------------------------------------------------
// RetryBudget
// ---------------------------------------------------------------------------

export interface RetryBudgetLevels {
  readonly locatorAttempts: number;
  readonly stepAttempts: number;
  readonly workflowAttempts: number;
}

export interface RetryBudget {
  readonly initial: RetryBudgetLevels;
  readonly remaining: RetryBudgetLevels;
  canRetry(level: 'locator' | 'step' | 'workflow'): boolean;
  consume(level: 'locator' | 'step' | 'workflow'): void;
  snapshot(): { locator: number; step: number; workflow: number };
  clone(): RetryBudget;
}

// ---------------------------------------------------------------------------
// EventBus
// ---------------------------------------------------------------------------

export interface EventBus {
  publish(event: TaskEvent): void;
  flush(): Promise<void>;
  persistedAt(): string;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// CheckpointStore
// ---------------------------------------------------------------------------

export interface Checkpoint {
  readonly schema_version: string;
  readonly run_id: string;
  readonly task_id: string;
  readonly after_step_id: string;
  readonly after_step_idx: number;
  readonly ts: string;
  readonly page_url: string | null;
  readonly captures: CaptureSnapshot;
  readonly scope_chain: readonly SecurityScope[];
  readonly budgets: { readonly locator: number; readonly step: number; readonly workflow: number };
}

export interface CheckpointSummary {
  readonly step_id: string;
  readonly ts: string;
  readonly after_step_idx: number;
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<void>;
  load(stepId: string): Promise<Checkpoint | null>;
  list(): Promise<CheckpointSummary[]>;
  loadLast(): Promise<Checkpoint | null>;
}

// ---------------------------------------------------------------------------
// StepResult — discriminated union returned by every step handler
// ---------------------------------------------------------------------------

export type StepResult =
  | { readonly kind: 'completed'; readonly captureKeys?: readonly string[] }
  | { readonly kind: 'retried'; readonly attempt: number; readonly reason: string }
  | { readonly kind: 'failed'; readonly failureClass: FailureClass; readonly error: Error }
  | { readonly kind: 'handoff_requested'; readonly reason: HandoffReason }
  | { readonly kind: 'ethics_refused'; readonly host: string; readonly rule: string; readonly reason: string }
  | { readonly kind: 'jump'; readonly toStepId: string };

// ---------------------------------------------------------------------------
// StepHandler
// ---------------------------------------------------------------------------

export type StepHandler<S extends Step> = (step: S, ctx: ExecutionContext) => Promise<StepResult>;

// ---------------------------------------------------------------------------
// RunOutcome
// ---------------------------------------------------------------------------

export type RunOutcome =
  | { readonly status: 'completed'; readonly outputKeys: readonly string[] }
  | { readonly status: 'failed'; readonly failureClass: FailureClass; readonly reportPath: string }
  | { readonly status: 'handoff'; readonly reportPath: string };

// ---------------------------------------------------------------------------
// ExecutionContext
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  readonly runId: string;
  readonly taskId: string;
  readonly plan: Plan;
  /** Step index cursor — mutable. Updated by the executor loop. */
  currentStepIdx: number;
  readonly captures: CaptureStore;
  readonly secrets: SecretResolver | null;
  readonly sanitizer: Sanitizer | null;
  readonly llmClient: LLMClient | null;
  readonly workflowLocators: WorkflowLocatorStore | null;
  readonly browser: BrowserSession | null;
  /** Active page for this run. Null until executor opens one. */
  page: Page | null;
  /** CDP host for locator resolution. Null when browser is absent. */
  locatorHost: InjectedScriptHost | null;
  readonly events: EventBus;
  readonly budgets: RetryBudget;
  readonly ethics: EthicsGate;
  readonly checkpoints: CheckpointStore;
  readonly scopeChain: readonly SecurityScope[];
  readonly logger: Logger;
  readonly clock: Clock;
  readonly runDir: string;
}

// ---------------------------------------------------------------------------
// EthicsGate (defined here to avoid circular imports with ethics/)
// ---------------------------------------------------------------------------

export interface EthicsGate {
  check(
    url: string,
    action: 'navigate' | 'fetch',
    ctx: { taskId: string; runId: string; stepId: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// DomExtractor — stub interface; actual extraction logic in packages/core/src/extraction/
// ---------------------------------------------------------------------------

export interface DomExtractor {
  extract(
    elementHandle: ElementHandle,
    schema: import('@yantra/protocol').ExtractionSchema,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// UsageWriter interface
// ---------------------------------------------------------------------------

export interface UsageWriter {
  append(call: UsageCall): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ValueRef resolution result
// ---------------------------------------------------------------------------

export type ResolvedValue = string | number | boolean | null | unknown;
export type ResolvedSecret = { readonly plaintext: string; readonly zero: () => void };

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export type { CaptureRef, ExtractionResultEnvelopeUnknown, FailureClass, HandoffReason, Plan, SecurityScope, SecretRef, Step, TaskEvent, UsageCall };
