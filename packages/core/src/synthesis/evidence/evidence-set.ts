/**
 * EvidenceSet assembly — the orchestration seam of evidence-first synthesis.
 *
 * `buildEvidenceSet` runs the full evidence pipeline and hands the composer a
 * single, ready-to-render {@link EvidenceSet}:
 *
 * ```text
 * docs
 *   → QueryProfile
 *   → source relevance gate (exclusions recorded)
 *   → near-duplicate source clustering (numbered sources)
 *   → eligibility gates + sentence-level support + ranking
 *   → similarity-based near-duplicate claim merge (citations unioned)
 *   → entity-anchored facet planner
 *   → EvidenceSet (budgets as caps, honest under-budget signal)
 * ```
 *
 * Two honesty rules live here:
 *
 * - **Budgets are caps, not fill targets.** The length budget bounds how many
 *   findings the composer *may* show; it never pads a thin set with weak
 *   sentences. When fewer relevant claims survive than requested,
 *   {@link EvidenceSet.underBudget} is set so the composer can state it plainly.
 * - **Near-duplicate merge.** Reworded restatements of the same claim collapse
 *   into the higher-salience claim with their citations unioned, so a finding
 *   is not shown twice under two hosts. Merge fires on lemma-cosine (>= 0.75),
 *   on a shared percent/money anchor (>= 0.5 cosine), on lemma containment
 *   (>= 0.9 — a claim restating a fragment of another), or on a normalized
 *   substring match.
 *
 * Pure and deterministic: same docs + query ⇒ same EvidenceSet.
 */

import type { BriefSource } from '@yantra/protocol';

import type { TextAnalyzer } from '../analysis/text-analyzer.js';
import { clusterSources } from '../clustering.js';
import type { SynthesisDoc, SynthesisInput, SynthesisLength } from '../types.js';

import { countCandidateSentences, extractEligibleClaims } from './eligibility.js';
import { buildFacetTable } from './facet-planner.js';
import { buildQueryProfile } from './query-profile.js';
import { gateRelevance } from './relevance.js';
import type { EvidenceClaim, EvidenceKind, EvidenceSet } from './types.js';

/** Key-finding budget per requested length (a **cap**, never a fill target). */
export const LENGTH_BUDGETS: Readonly<Record<SynthesisLength, number>> = {
  short: 3,
  medium: 6,
  long: 10,
};

/**
 * Claim-similarity at/above which two claims are treated as near-duplicates
 * and merged. Calibrated so reworded restatements (~0.80) merge while distinct
 * on-topic claims (~0.18) stay separate.
 */
const NEAR_DUP_THRESHOLD = 0.75;

/** Shared percent/money anchor floor for near-duplicate claims. */
export const NUMERIC_DUP_FLOOR = 0.5;

/**
 * Everything the deterministic composer needs to build a Brief: the assembled
 * {@link EvidenceSet} plus the clustering byproducts (numbered sources and the
 * doc→source-number map) it needs for citations.
 */
export interface EvidenceAssembly {
  /** The assembled evidence for the query. */
  readonly evidenceSet: EvidenceSet;
  /** The relevance-passing documents (index space of claim `docIndexes`). */
  readonly keptDocs: readonly SynthesisDoc[];
  /** Numbered, deduplicated sources built from the kept documents. */
  readonly sources: readonly BriefSource[];
  /** Map from kept-doc index to its source number (`sources[].n`). */
  readonly clusterNumberByDoc: readonly number[];
  /** Claim candidates considered before the eligibility gates. */
  readonly candidateClaims: number;
}

/**
 * Containment coefficient at/above which two claims merge regardless of
 * cosine: the smaller claim is lexically inside the larger one (a restated
 * fragment), so showing both would be duplicate information.
 */
export const CONTAINMENT_DUP_THRESHOLD = 0.9;

/** Working (mutable) claim used while merging near-duplicates. */
interface MergingClaim {
  readonly text: string;
  readonly kind: EvidenceClaim['kind'];
  readonly evidenceKinds: Set<EvidenceKind>;
  readonly anchorValues: Set<string>;
  readonly entityKeys: Set<string>;
  readonly docIndexes: Set<number>;
  readonly salience: number;
  readonly negated: boolean;
  readonly sentiment: number;
}

/**
 * Runs the evidence pipeline and assembles the {@link EvidenceSet}.
 *
 * @param input - Query, ranked docs, and per-source failures.
 * @param analyzer - Linguistic analyzer shared by every stage.
 * @param length - Requested length budget (used only as a cap signal).
 * @returns The assembly (EvidenceSet + clustering byproducts).
 */
export function buildEvidenceSet(
  input: SynthesisInput,
  analyzer: TextAnalyzer,
  length: SynthesisLength,
): EvidenceAssembly {
  const profile = buildQueryProfile(input.query, analyzer);

  const { keptDocIndexes, exclusions } = gateRelevance(input.docs, input.query, profile, analyzer);
  const keptDocs = keptDocIndexes.map((index) => input.docs[index]!);

  const { clusters, sources, clusterNumberByDoc } = clusterSources(keptDocs);

  const candidateClaims = countCandidateSentences(keptDocs, analyzer);
  const rankedClaims = extractEligibleClaims(keptDocs, profile, analyzer);
  const claims = mergeNearDuplicates(rankedClaims, analyzer);

  const facets = buildFacetTable(keptDocs, clusters, sources, profile, analyzer);

  const usedDocIndexes = [...new Set(claims.flatMap((claim) => [...claim.docIndexes]))].sort(
    (left, right) => left - right,
  );

  const evidenceSet: EvidenceSet = {
    profile,
    claims,
    facets,
    usedDocIndexes,
    exclusions,
    underBudget: claims.length < LENGTH_BUDGETS[length],
  };

  return { evidenceSet, keptDocs, sources, clusterNumberByDoc, candidateClaims };
}

/**
 * Collapses near-duplicate claims into the higher-salience one, unioning their
 * evidence. Claims arrive salience-descending, so the first accepted claim in a
 * duplicate group is always the strongest; later restatements merge into it.
 */
function mergeNearDuplicates(
  claims: readonly EvidenceClaim[],
  analyzer: TextAnalyzer,
): readonly EvidenceClaim[] {
  const accepted: MergingClaim[] = [];

  for (const claim of claims) {
    const match = accepted.find((existing) => shouldMerge(existing, claim, analyzer));
    if (match !== undefined) {
      claim.docIndexes.forEach((docIndex) => match.docIndexes.add(docIndex));
      claim.evidenceKinds.forEach((kind) => match.evidenceKinds.add(kind));
      claim.anchorValues.forEach((value) => match.anchorValues.add(value));
      claim.entityKeys.forEach((key) => match.entityKeys.add(key));
      continue;
    }
    accepted.push({
      text: claim.text,
      kind: claim.kind,
      evidenceKinds: new Set(claim.evidenceKinds),
      anchorValues: new Set(claim.anchorValues),
      entityKeys: new Set(claim.entityKeys),
      docIndexes: new Set(claim.docIndexes),
      salience: claim.salience,
      negated: claim.negated,
      sentiment: claim.sentiment,
    });
  }

  return accepted.map((claim) => ({
    text: claim.text,
    kind: claim.kind,
    evidenceKinds: [...claim.evidenceKinds],
    anchorValues: [...claim.anchorValues],
    entityKeys: [...claim.entityKeys].sort(),
    docIndexes: [...claim.docIndexes].sort((left, right) => left - right),
    salience: claim.salience,
    negated: claim.negated,
    sentiment: claim.sentiment,
  }));
}

/**
 * Near-duplicate test between an accepted claim and a candidate.
 *
 * **Polarity guard**: claims whose `negated` flags disagree never merge, no
 * matter how similar they look. Lemma cosine cannot tell "sales rose" from
 * "sales did not rise" (negators are stopwords and vanish from the bag), so
 * without the guard a claim could silently absorb its own contradiction and
 * union the two sources' citations under one text. Polarity-agreeing pairs
 * merge exactly as before (cosine / shared anchor / containment / substring).
 */
function shouldMerge(
  existing: MergingClaim,
  claim: EvidenceClaim,
  analyzer: TextAnalyzer,
): boolean {
  if (existing.negated !== claim.negated) {
    return false;
  }
  const similarity = analyzer.similarity(existing.text, claim.text);
  if (similarity >= NEAR_DUP_THRESHOLD) {
    return true;
  }
  if (
    similarity >= NUMERIC_DUP_FLOOR &&
    sharesAnchorValue(existing.anchorValues, claim.anchorValues)
  ) {
    return true;
  }
  // Containment catches a claim restating a *fragment* of another: cosine is
  // diluted by everything else the longer text says, but the shorter text's
  // lemma mass (or normalized text) sits inside the longer one.
  if (analyzer.containment(existing.text, claim.text) >= CONTAINMENT_DUP_THRESHOLD) {
    return true;
  }
  const existingKey = normalizeForSubstring(existing.text);
  const claimKey = normalizeForSubstring(claim.text);
  return existingKey.includes(claimKey) || claimKey.includes(existingKey);
}

/** Case/whitespace-normalized text for the substring duplicate check. */
function normalizeForSubstring(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function sharesAnchorValue(left: ReadonlySet<string>, right: readonly string[]): boolean {
  return right.some((value) => left.has(value));
}
