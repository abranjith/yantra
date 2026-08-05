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
  RankSignalSink,
  ModelSuppliedValues,
  UserInputVault,
  WorkflowCatalogEntry,
} from '@yantra/core';
import type { Brief, Result, TemplateManifest, TemplatedReport } from '@yantra/protocol';

import type { BudgetTracker } from './budget.js';
import type { WorkflowToolMode } from './profiles.js';
import type { AgentTrace } from './trace.js';
import type { UrlPolicy } from './url-policy.js';
import type { UrlProvenance } from './url-provenance.js';

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
   * @param brief The candidate content (agent-authored or complete Brief).
   * @param options `assembledByRuntime` marks the deterministic fallback path
   *   (the orchestrator packaging the agent's draft), stamped honestly into the
   *   Brief's metadata and notices.
   * @returns `ok(paths+brief)` on a successful, validated publication, or
   *   `err(validationError)` listing offending references.
   */
  readonly publish: (
    brief: unknown,
    options?: { readonly assembledByRuntime?: boolean },
  ) => Promise<Result<PublishOutcome, PublishValidationError>>;
}

/** Shared structural validation error consumed by the publication retry loop. */
export interface PublishValidationError extends Error {
  /** Pointer-addressed issues safe to return to the model for correction. */
  readonly issues: readonly {
    readonly path: readonly (string | number)[];
    readonly pointer: string;
    readonly message: string;
  }[];
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
  /** The validated persisted document; field name retained for compatibility. */
  readonly brief: Brief | TemplatedReport;
  /** Absolute path to the rendered `brief.html` or `document.html`. */
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
  /** Local-only observation sink; null disables ranking with no behavior change. */
  readonly rank: RankSignalSink | null;
  /** Deterministic saved-workflow discovery + invocation, or null when disabled. */
  readonly workflow: WorkflowToolDeps | null;
}

/** Ceilings keeping one evidence entry small enough for prompts and Briefs. */
const MAX_EVIDENCE_TITLE_CHARS = 200;
const MAX_EVIDENCE_EXCERPT_CHARS = 500;

/** One consulted web source, recorded as its tool returned evidence. */
export interface EvidenceEntry {
  /** URL as fetched (absolute). */
  readonly url: string;
  /** Post-redirect landing URL, or null when no redirect was observed. */
  readonly finalUrl: string | null;
  /** Page title, or null when unavailable. */
  readonly title: string | null;
  /** Short content snippet, or null when none was extracted. */
  readonly excerpt: string | null;
  /** ISO-8601 UTC timestamp of the fetch. */
  readonly fetchedAt: string;
  /** Publication timestamp as extracted (best-effort), or null when unknown. */
  readonly publishedAt: string | null;
  /** The tool that consulted the source. */
  readonly tool: 'web_search' | 'web_fetch' | 'browser_extract';
}

/**
 * Run-scoped record of every web source the agent consulted. The web tools
 * append each successfully fetched site and `browser_extract` appends each page
 * it read; `result_publish` and the runtime fallback publisher attach these
 * entries as the Brief's sources, so the model never has to round-trip URLs
 * through its own context (the observed failure mode behind placeholder
 * sources, "publication impossible" blockers, and post-nudge re-searching).
 *
 * Browser pages belong here for the same reason search hits do: a `do` run that
 * clicks its way to a price and extracts it drew its answer from that page, and
 * a Brief that instead cites only the search hop is not describing where its
 * facts came from.
 *
 * Title/excerpt text is page-derived (untrusted), so `add` runs it through the
 * run's sanitizer and bounds it — the ledger is its own chokepoint because its
 * entries flow into prompts (completion nudge) and artifacts (Brief sources)
 * without passing the tool-result middleware again.
 */
export class EvidenceLedger {
  private readonly byUrl = new Map<string, EvidenceEntry>();

  public constructor(private readonly sanitizer: PayloadSanitizer) {}

  /** Record one consulted source; first sighting of a URL wins (stable order). */
  public add(entry: EvidenceEntry): void {
    const key = entry.finalUrl ?? entry.url;
    if (this.byUrl.has(key)) return;
    this.byUrl.set(key, {
      ...entry,
      title: this.clean(entry.title, MAX_EVIDENCE_TITLE_CHARS),
      excerpt: this.clean(entry.excerpt, MAX_EVIDENCE_EXCERPT_CHARS),
    });
  }

  /** Consulted sources in first-consulted order. */
  public entries(): readonly EvidenceEntry[] {
    return [...this.byUrl.values()];
  }

  /** True when no source has been recorded yet. */
  public isEmpty(): boolean {
    return this.byUrl.size === 0;
  }

  private clean(text: string | null, maxChars: number): string | null {
    if (text === null) return null;
    const sanitized = this.sanitizer
      .sanitize(text, 'public')
      .text.replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maxChars);
    return sanitized.length > 0 ? sanitized : null;
  }
}

/**
 * Run-scoped evidence-phase latch. The orchestrator freezes it when the
 * completion nudge fires with evidence already in the ledger; the middleware
 * then rejects further evidence-gathering tool calls with `EVIDENCE_FROZEN`,
 * so a nudged model can only package what it has, never re-investigate its way
 * to a different conclusion.
 */
export class EvidencePhase {
  private frozen = false;

  /** True once evidence gathering has been closed for this run. */
  public isFrozen(): boolean {
    return this.frozen;
  }

  /** Close evidence gathering. Idempotent. */
  public freeze(): void {
    this.frozen = true;
  }
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
  /** Active report-template manifest, or null for the default Brief path. */
  readonly template: TemplateManifest | null;
  /** Run budget accountant (wall-clock, calls, bytes, hosts). */
  readonly budgets: BudgetTracker;
  /** The single LLM-bound sanitizer chokepoint. */
  readonly sanitizer: PayloadSanitizer;
  /**
   * Run-scoped vault of the user's own sensitive input values behind resolvable
   * placeholders. The middleware resolves placeholders in tool params at the
   * execution boundary (tools act on REAL values) and masks the values back to
   * placeholders in every model-visible result (the model only ever sees
   * tokens). Absent in vault-less test fixtures — resolution then no-ops.
   */
  readonly userInput?: UserInputVault;
  /**
   * Run-scoped record of strings the MODEL supplied in tool calls. Those values
   * are already in its context, so they are shielded from the page-content
   * redactors in every model-visible result — otherwise the agent watches its
   * own tracking number come back as `[redacted-phone]` and cannot tell whether
   * its action worked. Absent in test fixtures — preservation then no-ops.
   */
  readonly modelValues?: ModelSuppliedValues;
  /** Outbound URL controls (§8.13). */
  readonly urlPolicy: UrlPolicy;
  /**
   * Run-scoped record of every URL a tool result produced. `browser_navigate`
   * refuses targets absent from it, so the agent cannot navigate to a URL it
   * assembled itself. Required, not optional: a construction site that forgot
   * to supply it would silently disable the control.
   */
  readonly urlProvenance: UrlProvenance;
  /** Confirmation gateway + persistence, or null when no connector is wired. */
  readonly confirmation: ConfirmationServices | null;
  /** Run-scoped action-phase latch (closed by `result_publish`). */
  readonly actionPhase: ActionPhase;
  /** Run-scoped record of consulted web sources (attached to the Brief). */
  readonly evidence: EvidenceLedger;
  /** Latch closing evidence gathering at completion-nudge time. */
  readonly evidencePhase: EvidencePhase;
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
