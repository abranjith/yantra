/**
 * Synthesis engine types (FEAT-014).
 *
 * The Synthesize stage turns N extracted articles into **one** synthesized
 * {@link Brief} — the cross-source reasoning stage of the v2 pipeline
 * (`Search → Fetch → Extract → Synthesize → Render`). Two strategies sit
 * behind the single {@link Synthesizer} interface, mirroring the existing
 * `SearchProvider`/`LLMClient` strategy pattern:
 *
 * - `DeterministicSynthesizer` — no LLM, no network; the `--no-llm` contract
 *   and the golden-test backbone.
 * - `LlmSynthesizer` — sanitized public content in, validated Brief out,
 *   deterministic fallback on any failure.
 *
 * Layering note: `core` must not import `agent`, so the LLM dependency is
 * expressed as the minimal {@link SynthesisLlm} port declared here.
 * `apps/cli` adapts the real `LLMClient` to it at wiring time — the same
 * dependency-injection pattern `createLlmSummarizer()` uses today.
 */

import type { Brief, Result } from '@yantra/protocol';

import type { Sanitized } from '../sanitizer/brand.js';

/** Search-rank-ordered extracted article fed into synthesis. */
export interface SynthesisDoc {
  /** URL as fetched. */
  readonly url: string;
  /** Post-redirect landing URL, or null when no redirect was observed. */
  readonly finalUrl: string | null;
  /** Source host (derived from finalUrl ?? url). */
  readonly host: string;
  /** Page title, or null when unavailable. */
  readonly title: string | null;
  /** ISO-8601 UTC fetch timestamp. */
  readonly fetchedAt: string;
  /** ISO-8601 publication timestamp, or null when unknown. */
  readonly publishedAt: string | null;
  /** Extracted plain text (Readability output). */
  readonly text: string;
  /** Extractor-provided excerpt, or null. */
  readonly excerpt: string | null;
}

/** A per-source fetch/extract failure surfaced as an honest Brief notice. */
export interface SourceFailure {
  /** URL of the failed source. */
  readonly url: string;
  /** Host of the failed source. */
  readonly host: string;
  /** Which pipeline stage failed. */
  readonly stage: 'fetch' | 'extract' | 'blocked';
  /** Human-readable failure reason. */
  readonly reason: string;
}

/** Everything a synthesizer needs to produce one Brief. */
export interface SynthesisInput {
  /** The user's normalized question/topic. */
  readonly query: string;
  /** Extracted articles; array order = search rank (index 0 is rank 1). */
  readonly docs: readonly SynthesisDoc[];
  /** Per-source failures to surface as notices (honesty rule). */
  readonly failures: readonly SourceFailure[];
}

/** Synthesis strategy selection value. */
export type SynthesisStrategy = 'auto' | 'deterministic' | 'llm';

/** Progressive-disclosure depth of the produced Brief. */
export type SynthesisDetail = 'overview' | 'standard' | 'full';

/** Length budget controlling how many findings/sections are emitted. */
export type SynthesisLength = 'short' | 'medium' | 'long';

/** Contextual security scope driving the sanitizer profile. */
export type SynthesisScope = 'public' | 'read-only-data' | 'authenticated';

/** Options controlling one synthesis invocation. */
export interface SynthesisOptions {
  /**
   * Strategy selection: `auto` = LLM for `public` scope (when available),
   * deterministic for anything else. See `selectSynthesizer`.
   */
  readonly strategy: SynthesisStrategy;
  /** Synthesis depth: which Brief blocks to fill. */
  readonly detail: SynthesisDetail;
  /** Findings/sections budget: short=3, medium=6, long=10 key findings. */
  readonly length: SynthesisLength;
  /** Contextual scope; selects the sanitizer profile on the LLM path. */
  readonly scope: SynthesisScope;
  /** Originating task id (ULID) stamped as the Brief's task_id. */
  readonly taskId: string;
  /** Owning run id recorded in Brief metadata. */
  readonly runId: string;
  /** Search provider that produced the source candidates, or null. */
  readonly searchProvider: string | null;
  /**
   * Optional subtopic hints (FEAT-017): the research coverage tracker's
   * subtopic labels, passed to guide per-subtopic organization of the
   * long-form document. Ignored by the deterministic strategy; forwarded to
   * the prompt on the LLM path. Absent for single-hop `ask`.
   */
  readonly hints?: readonly string[];
  /**
   * Optional privacy-gated personalization context (FEAT-018). A short,
   * bounded, **already-sanitized** preference summary (e.g. "Prefers metric
   * units. Favors retailers: X, Y."). The `Sanitized<string>` brand makes this
   * slot un-fillable with raw text: only `buildPersonalizationContext` output
   * (preferences → `sanitize()` → brand) can be assigned. Raw history rows have
   * no path here — the structural anti-leak guarantee (plan §6). Forwarded to
   * the prompt on the LLM path; ignored by the deterministic strategy.
   */
  readonly personalization?: Sanitized<string>;
}

/** Citation-faithfulness verdict emitted by the post-synthesis validator. */
export interface CitationVerdict {
  /** Number of claims inspected. */
  readonly claimsChecked: number;
  /** Claims flagged as unanchored (kept, noticed). */
  readonly flagged: number;
  /** Claims stripped as unanchored (removed, noticed). */
  readonly stripped: number;
}

/** The result of a successful synthesis. */
export interface SynthesisOutcome {
  /** Schema-valid, citation-validated document. */
  readonly brief: Brief;
  /** Citation-faithfulness verdict (also stamped into brief.metadata). */
  readonly verdict: CitationVerdict;
  /** Which strategy actually produced the Brief. */
  readonly strategyUsed: 'deterministic' | 'llm';
  /** True when the LLM path failed and the deterministic path took over. */
  readonly fallbackUsed: boolean;
}

/** A near-duplicate source group (internal to deterministic synthesis). */
export interface SourceCluster {
  /** Doc index of the cluster representative (highest search rank member). */
  readonly representative: number;
  /** Doc indexes of all members, representative included, rank order. */
  readonly members: readonly number[];
  /** Pairwise similarity that formed the cluster (0-1; 1 for singletons). */
  readonly similarity: number;
}

/** Classification of an extracted candidate claim. */
export type ClaimKind = 'fact' | 'number' | 'entity' | 'quote';

/** A candidate claim extracted from the doc set (internal). */
export interface ExtractedClaim {
  /** The claim sentence text. */
  readonly text: string;
  /** Doc indexes providing evidence for this claim (always >= 1 entry). */
  readonly docIndexes: readonly number[];
  /** What kind of signal surfaced the claim. */
  readonly kind: ClaimKind;
  /** Ranking score; higher = more likely to become a key finding. */
  readonly salience: number;
}

/**
 * Error returned (never thrown) by synthesizers, carrying the query and
 * strategy context per the project error-class convention.
 */
export class SynthesisError extends Error {
  public override readonly name = 'SynthesisError';

  public constructor(
    message: string,
    public readonly context: {
      /** The query being synthesized when the failure occurred. */
      readonly query: string;
      /** The strategy that failed. */
      readonly strategy: 'deterministic' | 'llm';
      /** Underlying cause, when available. */
      readonly cause?: unknown;
    },
  ) {
    super(message);
  }
}

/**
 * The Synthesize pipeline-stage strategy interface.
 *
 * Identical in shape to the existing `SearchProvider`/`LLMClient` strategy
 * pattern: both implementations produce the same `Brief`, so the renderer
 * and tests are strategy-agnostic. All failures are returned as
 * `Result` errors — synthesizers never throw.
 */
export interface Synthesizer {
  /** Which strategy this synthesizer implements. */
  readonly strategy: 'deterministic' | 'llm';
  /**
   * Turns the extracted doc set into one schema-valid, citation-validated
   * Brief.
   *
   * @param input - Query, ranked docs, and per-source failures.
   * @param opts - Strategy, depth/length budgets, scope, and provenance.
   * @returns The synthesis outcome, or a `SynthesisError` on failure.
   */
  synthesize(
    input: SynthesisInput,
    opts: SynthesisOptions,
  ): Promise<Result<SynthesisOutcome, SynthesisError>>;
}

// ---------------------------------------------------------------------------
// SynthesisLlm port — the minimal LLM dependency of the LLM strategy.
// ---------------------------------------------------------------------------

/** Token/cost usage reported by the LLM port for one call. */
export interface SynthesisLlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** One prompt round sent through the port. Payloads MUST be pre-sanitized. */
export interface SynthesisLlmRequest {
  /** System prompt (template text, no document content). */
  readonly system: string;
  /** User prompt assembled from sanitized document text only. */
  readonly user: string;
}

/** Raw model response returned by the port. */
export interface SynthesisLlmResponse {
  /** The model's text output (expected to contain a JSON document). */
  readonly text: string;
  /** Usage totals for this call, or null when the provider reports none. */
  readonly usage: SynthesisLlmUsage | null;
}

/** Failure classes the port can report. */
export type SynthesisLlmError =
  | {
      /** Provider is not configured/reachable — fall back silently. */
      readonly kind: 'llm_unavailable';
      readonly message: string;
    }
  | {
      /** The call itself failed (timeout, provider error). */
      readonly kind: 'llm_failed';
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Minimal LLM port the `LlmSynthesizer` depends on.
 *
 * Declared core-side so `core` never imports `agent` (layering rule).
 * `apps/cli` adapts the real `LLMClient` to this shape at wiring time.
 * Every `send` call site is covered by the sanitize-before-send CI static
 * check (`scripts/ci-static-check.ts`).
 */
export interface SynthesisLlm {
  /** Identity string for logging, for example "anthropic:claude-sonnet-4-6". */
  readonly providerId: string;
  /** Sends one pre-sanitized prompt round and returns the raw response. */
  send(request: SynthesisLlmRequest): Promise<Result<SynthesisLlmResponse, SynthesisLlmError>>;
}

// ---------------------------------------------------------------------------
// Prompt template port — prompt text lives agent-side, injected as data.
// ---------------------------------------------------------------------------

/** One numbered source block presented to the model. */
export interface SynthesisPromptSource {
  /** Citation number (1..N, cluster order). */
  readonly n: number;
  /** Source host. */
  readonly host: string;
  /** Page title, or null. */
  readonly title: string | null;
  /** Sanitized extracted text. */
  readonly text: string;
}

/** Inputs the user-prompt builder receives. */
export interface SynthesisPromptInput {
  readonly query: string;
  readonly sources: readonly SynthesisPromptSource[];
  readonly detail: SynthesisDetail;
  readonly length: SynthesisLength;
  /** Optional subtopic hints to organize the document by (FEAT-017). */
  readonly hints?: readonly string[];
  /**
   * Optional sanitized personalization context (FEAT-018). Plain string here —
   * the `Sanitized` brand is enforced at the `SynthesisOptions` boundary; by the
   * time it reaches the (agent-side) prompt template it is already trusted text.
   */
  readonly personalization?: string;
}

/**
 * Prompt template injected into `LlmSynthesizer`.
 *
 * The concrete template lives in `packages/agent/src/synthesis/prompt.ts`
 * (structurally compatible — agent cannot import this type because the
 * `agent → core` import direction is forbidden); `apps/cli` passes it in.
 */
export interface SynthesisPromptTemplate {
  /** Static system prompt. */
  readonly system: string;
  /** Builds the user prompt from the query and sanitized numbered sources. */
  buildUser(input: SynthesisPromptInput): string;
  /** Builds the bounded re-prompt from serialized validation issue paths. */
  buildReprompt(issues: readonly { pointer: string; message: string }[]): string;
}
