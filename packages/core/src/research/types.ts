/**
 * Deep-research mode types (FEAT-017).
 *
 * `yantra research` runs a **bounded multi-hop** loop — search → fetch →
 * extract → synthesize → generate follow-up queries → diversify/dedup
 * sources → track coverage — and emits one long-form, sectioned {@link Brief}.
 * Everything is budgeted (hops, sources, wall-clock, LLM calls) and the loop
 * terminates cleanly when any budget exhausts, emitting an honest partial
 * Brief rather than hanging or truncating silently.
 *
 * The loop reuses the whole modern retrieval stack: the FEAT-016 search
 * provider, the FEAT-014 synthesizer (per-hop gap analysis + one final
 * long-form synthesis), and the FEAT-015 renderer/artifacts. The LLM
 * dependency for follow-up query generation is expressed as the minimal
 * {@link SynthesisLlm} port already declared in `synthesis/types.ts`, so
 * `core` never imports `agent` (layering rule).
 */

import type { Brief } from '@yantra/protocol';

import type { BriefArtifactPaths } from '../brief/write-artifacts.js';
import type { SynthesisLength, SynthesisScope } from '../synthesis/types.js';

/**
 * The four budgets bounding one research run. Every field is a hard cap; the
 * {@link BudgetTracker} enforces them behind a single `checkpoint()` API.
 */
export interface ResearchBudget {
  /** Maximum hops (search→synthesize iterations), 1–3. From `--depth`. */
  readonly maxHops: number;
  /** Maximum sources kept across all hops. From `--max-sources`. */
  readonly maxSources: number;
  /** Wall-clock budget in milliseconds. From `--pipeline-timeout`. */
  readonly maxWallClockMs: number;
  /** Maximum LLM calls (gap analysis + query-gen + synthesis). From `--max-llm-calls`. */
  readonly maxLlmCalls: number;
}

/** Default budgets when flags are omitted (plan §2). */
export const DEFAULT_RESEARCH_BUDGET: ResearchBudget = {
  maxHops: 2,
  maxSources: 24,
  maxWallClockMs: 180_000,
  maxLlmCalls: 12,
};

/** Which budget dimension a stop was triggered by. */
export type BudgetDimension = 'wall_clock' | 'max_sources' | 'max_llm_calls' | 'max_hops';

/**
 * Returned (never thrown) by {@link BudgetTracker.checkpoint} when a budget is
 * exhausted. The loop treats this as a *success with notice*, not a failure.
 */
export interface BudgetExhausted {
  /** Which budget triggered the stop. */
  readonly dimension: BudgetDimension;
  /** Human-readable reason for the notice/metadata. */
  readonly message: string;
}

/** A point-in-time snapshot of remaining budget, persisted in ResearchState. */
export interface BudgetSnapshot {
  readonly hopsUsed: number;
  readonly hopsRemaining: number;
  readonly sourcesUsed: number;
  readonly sourcesRemaining: number;
  readonly llmCallsUsed: number;
  readonly llmCallsRemaining: number;
  readonly elapsedMs: number;
  readonly wallClockRemainingMs: number;
}

/** The record of one hop, appended to {@link ResearchState.hops}. */
export interface ResearchHop {
  /** 1-based hop index. */
  readonly index: number;
  /** Queries issued this hop. */
  readonly queries: readonly string[];
  /** Number of raw search results returned this hop. */
  readonly resultsCount: number;
  /** Documents successfully fetched+extracted this hop. */
  readonly docsFetched: number;
  /** Documents kept after dedup/diversification this hop. */
  readonly docsKept: number;
  /** Subtopics still uncovered after this hop — drives the next hop's queries. */
  readonly gapsIdentified: readonly string[];
  /** Coverage score (0–1) after this hop. */
  readonly coverage: number;
}

/**
 * Why the loop stopped. Priority order (any → stop): coverage target met,
 * max hops reached, then the budget dimensions. `no_novel_queries` covers the
 * case where gap analysis produced no fresh follow-ups.
 */
export type TerminationReason = 'coverage_met' | 'max_hops' | 'no_novel_queries' | BudgetDimension;

/** Options controlling one research run. */
export interface ResearchOptions {
  /** The research topic (raw user input). */
  readonly topic: string;
  /** Budget caps for this run. */
  readonly budget: ResearchBudget;
  /** Force the deterministic path (agent-optional invariant). */
  readonly noLlm: boolean;
  /** Long-form length budget for the final synthesis; defaults to `long`. */
  readonly length: SynthesisLength;
  /** Contextual scope (research is `public` only in this feature). */
  readonly scope: SynthesisScope;
  /** Search results to request per query. */
  readonly perQueryLimit: number;
  /** Per-fetch timeout in milliseconds. */
  readonly perFetchTimeoutMs: number;
  /** Coverage score at/above which the loop stops early (default 0.9). */
  readonly coverageTarget: number;
}

/**
 * The checkpointable per-hop summary persisted to `research-state.json`.
 * Carries pool *identity* (urls + text hashes) rather than full text — enough
 * for post-mortem inspection without duplicating the fetched corpus.
 */
export interface ResearchState {
  /** The research topic. */
  readonly topic: string;
  /** All hops executed so far. */
  readonly hops: readonly ResearchHop[];
  /** Deduplicated pool identity (numbered url + text hash). */
  readonly pool: readonly { readonly url: string; readonly host: string; readonly hash: string }[];
  /** Coverage snapshot: per-subtopic covered flag + weight. */
  readonly coverage: {
    readonly score: number;
    readonly subtopics: readonly {
      readonly label: string;
      readonly covered: boolean;
      readonly weight: number;
    }[];
  };
  /** Remaining budget snapshot. */
  readonly budgetRemaining: BudgetSnapshot;
  /** Termination reason once the loop has finished, else null. */
  readonly terminationReason: TerminationReason | null;
}

/** The result of a research run: the Brief plus its provenance. */
export interface ResearchRunResult {
  /** The synthesized long-form Brief. */
  readonly brief: Brief;
  /** Paths of the persisted brief.json/md/html, or null when the write failed. */
  readonly artifacts: BriefArtifactPaths | null;
  /** Every hop's summary. */
  readonly hops: readonly ResearchHop[];
  /** Why the loop stopped. */
  readonly terminationReason: TerminationReason;
}
