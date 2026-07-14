/**
 * Evidence type spine (FEAT-FP-001) — internal to `@yantra/core`.
 *
 * These types express the "evidence selection first, document assembly
 * second" contract: the deterministic pipeline profiles the query, gates
 * sources and claims against that profile, then assembles an
 * {@link EvidenceSet} the composer turns into a {@link Brief}. Every stage is
 * a pure function of its inputs, so the whole spine is golden-testable.
 *
 * Nothing here is persisted or crosses the protocol boundary; the Brief schema
 * changes (new notice kinds, `metadata.evidence`) live in `@yantra/protocol`.
 */

import type { ClaimKind } from '../types.js';

/**
 * The query's inferred information intent, which drives every downstream gate:
 * which evidence kinds are required, which facet columns are buildable, and
 * how strict the relevance floor is.
 */
export type QueryIntent =
  | 'price_lookup'
  | 'comparison'
  | 'rate_or_trend'
  | 'factual_lookup'
  | 'entity_profile'
  | 'general';

/**
 * The evidence categories a claim can carry, in the pipeline's own vocabulary
 * (mapped from the analyzer's {@link EntityKind}: `cardinal → quantity`,
 * `named → entity`, plus `statement` for prose without a typed figure).
 */
export type EvidenceKind = 'money' | 'percent' | 'quantity' | 'date' | 'entity' | 'statement';

/** How time-bound the query is, from "today/latest/2026"-style markers. */
export type TimeSensitivity = 'current' | 'recent' | 'timeless';

/**
 * A comparison column that is buildable for the profiled query. The facet
 * planner emits only the columns listed here, and only when enough sources
 * carry an anchored value of {@link entityKind}.
 */
export interface FacetPlan {
  /** Column header (for example `"Price"`). */
  readonly column: string;
  /** The evidence kind whose values populate the column. */
  readonly entityKind: EvidenceKind;
}

/**
 * Deterministic profile of the user's query. Produced once by the query
 * profiler and threaded through every gate.
 */
export interface QueryProfile {
  /** Inferred intent driving eligible evidence kinds and facets. */
  readonly intent: QueryIntent;
  /** Named entities / noun phrases lifted from the query (lemmatized). */
  readonly targetEntities: readonly string[];
  /** Informative query lemmas used by the relevance gates. */
  readonly mustMatchTerms: readonly string[];
  /** Evidence kinds a numeric claim must carry to be eligible. */
  readonly requiredEvidenceKinds: readonly EvidenceKind[];
  /** Comparison columns buildable for this query (may be empty). */
  readonly facetPlan: readonly FacetPlan[];
  /** How time-bound the query is. */
  readonly timeSensitivity: TimeSensitivity;
}

/**
 * A claim that has passed the eligibility gates, carrying **sentence-level**
 * evidence (not whole-doc overlap) and the typed figures its sentence holds.
 */
export interface EvidenceClaim {
  /** The claim sentence text. */
  readonly text: string;
  /** Section-grouping classification (reuses the existing {@link ClaimKind}). */
  readonly kind: ClaimKind;
  /** Typed evidence kinds the sentence carries (may be empty for a statement). */
  readonly evidenceKinds: readonly EvidenceKind[];
  /** Normalized percent/money values used for numeric-aware duplicate merge. */
  readonly anchorValues: readonly string[];
  /**
   * Word-level keys of the sentence's named entities (lower-cased tokens of
   * each PROPN run: `"Erling Haaland"` → `"erling"`, `"haaland"`). Drives the
   * topic-group nesting anchor: a child must share a named-entity key or an
   * anchor value with its parent to nest under it.
   */
  readonly entityKeys: readonly string[];
  /** Doc indexes whose sentences actually restate this claim (>= 1 entry). */
  readonly docIndexes: readonly number[];
  /** Ranking score (existing salience formula, computed over the gated set). */
  readonly salience: number;
}

/**
 * A candidate value for one facet column, anchored to the sentence it came
 * from. Only {@link anchored} candidates are eligible for the comparison table.
 */
export interface FacetCandidate {
  /** Target column header (matches a {@link FacetPlan.column}). */
  readonly column: string;
  /** The value's display text (for example `"$328"`). */
  readonly value: string;
  /** Doc index the value was found in. */
  readonly docIndex: number;
  /** The sentence the value came from (anchoring evidence). */
  readonly sentence: string;
  /** True when the value's sentence also carries a target entity / metric term. */
  readonly anchored: boolean;
}

/**
 * A source dropped by the relevance gate before clustering/numbering, recorded
 * so the Brief can surface it as an honest `source_excluded` notice.
 */
export interface SourceExclusion {
  /** Index of the excluded doc in the original input array. */
  readonly docIndex: number;
  /** Host of the excluded source. */
  readonly host: string;
  /** Human-readable reason (for example `no overlap with query terms ...`). */
  readonly reason: string;
}

/**
 * The accepted, anchored comparison table (internal shape; the composer maps
 * it to the protocol's `BriefFacets`). `null` when no column cleared its bar.
 */
export interface AcceptedFacets {
  /** Column headers, `Source` first. */
  readonly columns: readonly string[];
  /** One row per contributing source, cells index-aligned with {@link columns}. */
  readonly rows: readonly (readonly (string | null)[])[];
}

/**
 * The assembled evidence for one query: everything the composer needs to build
 * the Brief, with budgets already applied as caps and near-duplicates merged.
 */
export interface EvidenceSet {
  /** The query profile the evidence was gated against. */
  readonly profile: QueryProfile;
  /** Accepted, ranked, near-duplicate-merged claims. */
  readonly claims: readonly EvidenceClaim[];
  /** Accepted anchored comparison table, or null. */
  readonly facets: AcceptedFacets | null;
  /** Doc indexes represented in the accepted evidence (relevance-passing). */
  readonly usedDocIndexes: readonly number[];
  /** Sources dropped by the relevance gate, with reasons. */
  readonly exclusions: readonly SourceExclusion[];
  /** True when accepted findings fall short of the requested length budget. */
  readonly underBudget: boolean;
}
