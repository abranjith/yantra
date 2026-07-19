/**
 * RunServices — the per-run dependency bundle handed to every tool wrapper
 * (FEAT-024 TASK-003, plan_agentic.md §5/§6).
 *
 * A single immutable object carries the cross-cutting middleware services
 * (budgets, sanitizer, outbound URL policy, confirmation gateway, abort signal,
 * clock) plus the SDK-neutral domain operations the four initial tools invoke.
 * Tool business logic lives in `@yantra/core` as ordinary functions; the Pi
 * wrappers are thin (plan §3), so a future provider needs only new wrappers,
 * not new services.
 */

import type {
  ConfirmationGateway,
  ConfirmationStore,
  ContentFetcher,
  EthicsGate,
  Extractor,
  PayloadSanitizer,
  SearchProvider,
  SearchProviderName,
  SearchResult,
  AgentBrowserController,
  OpaqueRefResolver,
  WorkflowCatalogEntry,
} from '@yantra/core';
import type { Brief, BriefValidationError, Result } from '@yantra/protocol';

import type { BudgetTracker } from './budget.js';
import type { WorkflowToolMode } from './profiles.js';
import type { AgentTrace } from './trace.js';
import type { UrlPolicy } from './url-policy.js';

/** Confirmation dependencies (gateway + optional persistence). */
export interface ConfirmationServices {
  /** Human-consent gateway; blocks until resolved (plan §5). */
  readonly gateway: ConfirmationGateway;
  /** Persists request/decision lines to `confirmations.jsonl`; null in tests. */
  readonly store: ConfirmationStore | null;
}

/**
 * `web_search` domain dependencies. The provider is resolved once at run setup
 * (respecting provider policy/keys); `resultCap` bounds normalized output.
 */
export interface SearchToolDeps {
  /**
   * Resolve the active search provider for this run. Returns a retryable error
   * when no provider is available (missing key, all providers down) so the tool
   * surfaces a stable error rather than crashing.
   */
  readonly resolveProvider: () => Promise<Result<SearchProvider, { readonly message: string }>>;
  /** Maximum search hits requested from the provider (search breadth). */
  readonly resultCap: number;
  /**
   * How many of the top hits the combined `web_search` tool fetches + extracts
   * inline (`search.fetch_top`). The rest are returned as snippet-only "more
   * results". Bounded to a small number so one result cannot evict a small
   * model's context.
   */
  readonly fetchTop: number;
}

/** `web_fetch` domain dependencies (fetch → extract → sanitize path). */
export interface FetchToolDeps {
  /** HTTP-first content fetcher with timeout + size guards. */
  readonly fetcher: ContentFetcher;
  /** Readability-based article extractor. */
  readonly extractor: Extractor;
  /** Ethics gate (robots/blocklist/rate limit) checked before every fetch. */
  readonly ethics: EthicsGate;
  /** Allowed response content-type prefixes (e.g. `text/html`, `text/plain`). */
  readonly allowedContentTypes: readonly string[];
  /** Hard byte cap on a fetched body (streamed abort over-limit). */
  readonly maxContentBytes: number;
  /** Threshold above which extracted text is stored as a capture reference. */
  readonly captureThresholdBytes: number;
}

/**
 * Minimal structural view of the allowlisted script registry (`@yantra/core`
 * `ScriptRegistry`). Declared here structurally so RunServices does not depend
 * on the concrete registry class.
 */
export interface ScriptExecutorLike {
  /** True when a script id is registered. */
  has(id: string): boolean;
  /** Registered script ids (for error hints). */
  ids(): readonly string[];
  /**
   * Run a registered script out-of-process with enforced caps.
   *
   * @returns A structured success or a stable-coded failure; never throws for
   *   expected conditions (unknown id, bad args, timeout, oversize output).
   */
  run(id: string, args: unknown, opts: { readonly signal: AbortSignal }): Promise<ScriptRunOutcome>;
}

/** Outcome of a `ScriptExecutorLike.run` call. */
export type ScriptRunOutcome =
  | {
      readonly ok: true;
      /** Model-visible transformation output (bounded by the registry). */
      readonly output: unknown;
      /** True when the output was truncated at the registry's cap. */
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      /** Stable machine code (`SCRIPT_NOT_FOUND`, `SCRIPT_INVALID_ARGS`, …). */
      readonly errorCode: string;
      /** Secret-free explanation. */
      readonly message: string;
      /** Whether a corrected call could succeed. */
      readonly retryable: boolean;
    };

/** `script_run` domain dependencies. */
export interface ScriptToolDeps {
  /** The code-defined registry of allowlisted transformation scripts. */
  readonly registry: ScriptExecutorLike;
}

/** `result_publish` domain dependencies. */
export interface PublishToolDeps {
  /**
   * Validate a candidate Brief (schema + citation/evidence) and, on success,
   * persist `brief.json/md/html` to the run directory.
   *
   * @returns `ok(paths+brief)` on a successful, validated publication, or
   *   `err(validationError)` listing offending references.
   */
  readonly publish: (brief: unknown) => Promise<Result<PublishOutcome, BriefValidationError>>;
}

/** Input for one nested deterministic workflow run. */
export interface WorkflowRunInput {
  readonly workflow: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
}

/** Context threaded into a nested workflow run. */
export interface WorkflowRunContext {
  /** Abort signal (run abort ∪ per-tool timeout). */
  readonly signal: AbortSignal;
  /**
   * Consent gateway for `requires_confirmation` steps inside the workflow. When
   * null (scheduled/non-interactive surfaces), a flagged step fails closed.
   */
  readonly confirmationGateway: ConfirmationGateway | null;
}

/** Outcome of a nested workflow run, projected for the model-visible tool result. */
export type WorkflowRunToolOutcome =
  | {
      readonly ok: true;
      /** The nested run's own run id (join key for audit). */
      readonly runId: string;
      /** Number of workflow steps declared. */
      readonly stepCount: number;
      /** Persisted, redacted outputs (sanitized/bounded before reaching the model). */
      readonly outputs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      /** Stable machine code (`WORKFLOW_RUN_FAILED`, `WORKFLOW_RUN_ABORTED`, …). */
      readonly errorCode: string;
      /** Secret-free explanation. */
      readonly message: string;
      /** The nested run id when the run started, else null. */
      readonly runId: string | null;
      /** Whether a corrected retry could succeed. */
      readonly retryable: boolean;
    };

/**
 * `workflow_run` domain dependencies. Discovery returns the secret-free catalog;
 * `run` invokes the existing deterministic `RunOrchestrator` (LLM-free by
 * construction — the executor path never imports `@yantra/agent`).
 */
export interface WorkflowToolDeps {
  /** Secret-free catalog of saved workflows for agent discovery. */
  listCatalog(): Promise<readonly WorkflowCatalogEntry[]>;
  /** Execute a saved workflow deterministically in its own nested run directory. */
  run(input: WorkflowRunInput, ctx: WorkflowRunContext): Promise<WorkflowRunToolOutcome>;
}

/** Browser tool dependencies for the run's single ephemeral controller. */
export interface BrowserToolDeps {
  readonly controller: AgentBrowserController;
  readonly ethics: EthicsGate;
  readonly secretResolver: OpaqueRefResolver | null;
  /** Trusted metadata lookup; bindings never come from model input. */
  readonly secretHosts: (key: string) => Promise<readonly string[]>;
  readonly captureThresholdBytes: number;
}

/** Successful publication artifacts. */
export interface PublishOutcome {
  /** The validated, persisted Brief. */
  readonly brief: Brief;
  /** Absolute path to the rendered `brief.html`. */
  readonly htmlPath: string;
  /** One-line human summary for the model-visible result. */
  readonly summary: string;
}

/** The SDK-neutral domain operations backing the initial tools. */
export interface ToolDomainDeps {
  readonly search: SearchToolDeps;
  readonly fetch: FetchToolDeps;
  readonly script: ScriptToolDeps;
  readonly publish: PublishToolDeps;
  readonly browser: BrowserToolDeps | null;
  /** Deterministic saved-workflow discovery + invocation, or null when disabled. */
  readonly workflow: WorkflowToolDeps | null;
}

/**
 * Run-scoped action-phase latch. `result_publish` closes it on the single
 * successful publication; the middleware then rejects later mutating tool calls
 * with `ACTION_PHASE_CLOSED` (plan §8.9).
 */
export class ActionPhase {
  private closed = false;

  /** True once a terminal publication has closed the action phase. */
  public isClosed(): boolean {
    return this.closed;
  }

  /** Close the action phase. Idempotent. */
  public close(): void {
    this.closed = true;
  }
}

/** The immutable per-run dependency bundle handed to `createYantraTools`. */
export interface RunServices {
  /** Owning run id. */
  readonly runId: string;
  /** Absolute path of the owning run directory. */
  readonly runDir: string;
  /** Run budget accountant (wall-clock, calls, bytes, hosts). */
  readonly budgets: BudgetTracker;
  /** The single LLM-bound sanitizer chokepoint. */
  readonly sanitizer: PayloadSanitizer;
  /** Outbound URL controls (§8.13). */
  readonly urlPolicy: UrlPolicy;
  /** Confirmation gateway + persistence, or null when no connector is wired. */
  readonly confirmation: ConfirmationServices | null;
  /** Run-scoped action-phase latch (closed by `result_publish`). */
  readonly actionPhase: ActionPhase;
  /**
   * Run-scoped successful-interaction trace, or null when promotion is not
   * wired for this run. Browser tools append on each successful action; the
   * orchestrator writes it to `trace.json` and feeds `--save-as` promotion.
   */
  readonly trace: AgentTrace | null;
  /** Abort signal (user interrupt or budget exhaustion) threaded into every op. */
  readonly abortSignal: AbortSignal;
  /** Millisecond clock (injectable for deterministic tests). */
  readonly now: () => number;
  /** ISO-8601 timestamp source. */
  readonly nowIso: () => string;
  /** SDK-neutral domain operations for the four initial tools. */
  readonly domain: ToolDomainDeps;
  /** Command-profile restriction for the optional deterministic workflow tool. */
  readonly workflowToolMode?: WorkflowToolMode;
}

export type { SearchProviderName, SearchResult };
