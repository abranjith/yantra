/**
 * Topic grouping for deterministic synthesis findings.
 *
 * The evidence set remains the flat, ranked truth. Composition can then group
 * nearby claims so the rendered Brief reads like an editor organized it:
 * highest-salience claim as the parent, lower-salience related claims as
 * children. A child must be **related to but not a duplicate of** its parent:
 *
 * - **similarity ≥ {@link TOPIC_THRESHOLD}** — same topic;
 * - **containment < {@link TOPIC_CONTAINMENT_DUP}** — not a restatement of
 *   the parent (a claim failing only this test is treated as a duplicate: its
 *   citations union into the parent and it is dropped — belt-and-braces
 *   behind the evidence-set merge);
 * - **shares an anchor** — at least one named-entity key or percent/money
 *   anchor value in common with the parent, so "mentions the same topic
 *   words" alone is not enough to nest.
 *
 * Greedy and deterministic: claims arrive salience-ranked, and each claim is
 * evaluated against the first existing group whose parent clears the
 * similarity threshold; failing the nesting criteria there, it founds its own
 * group.
 */

import type { TextAnalyzer } from '../analysis/text-analyzer.js';

import type { EvidenceClaim } from './types.js';

/** Topic similarity threshold: below merge floors, above incidental overlap. */
export const TOPIC_THRESHOLD = 0.4;

/** Containment at/above which a would-be child is a duplicate, not a child. */
export const TOPIC_CONTAINMENT_DUP = 0.85;

/** Maximum child findings shown directly under a parent finding. */
export const MAX_CHILDREN_PER_FINDING = 2;

export interface TopicGroup {
  /** Highest-salience member and display parent. */
  readonly parent: EvidenceClaim;
  /** Remaining members in rank order. */
  readonly children: readonly EvidenceClaim[];
}

/**
 * Greedily groups claims by similarity to each group's parent, nesting only
 * genuinely related non-duplicates (see the module header for the criteria).
 *
 * @param claims - Flat salience-ranked claims.
 * @param analyzer - Text similarity/containment implementation.
 * @param threshold - Minimum parent similarity to be considered for a group.
 * @returns Rank-ordered groups; duplicate claims are absorbed into their
 *   parent's citations rather than shown.
 */
export function groupClaimsByTopic(
  claims: readonly EvidenceClaim[],
  analyzer: TextAnalyzer,
  threshold = TOPIC_THRESHOLD,
): readonly TopicGroup[] {
  interface MutableGroup {
    parent: EvidenceClaim;
    children: EvidenceClaim[];
  }

  const groups: MutableGroup[] = [];
  for (const claim of claims) {
    const group = groups.find(
      (candidate) => analyzer.similarity(candidate.parent.text, claim.text) >= threshold,
    );

    if (group === undefined) {
      groups.push({ parent: claim, children: [] });
      continue;
    }

    if (
      claim.negated === group.parent.negated &&
      analyzer.containment(group.parent.text, claim.text) >= TOPIC_CONTAINMENT_DUP
    ) {
      // Duplicate of the parent: absorb its evidence, don't render it. The
      // polarity check mirrors the evidence-set merge guard — "sales did not
      // rise" has the same lemma bag as "sales rose" (containment 1.0), and a
      // contradiction must stay visible with its own citations, never be
      // silently absorbed into the claim it disputes.
      group.parent = withUnionedEvidence(group.parent, claim);
      continue;
    }

    if (sharesAnchor(group.parent, claim)) {
      group.children.push(claim);
    } else {
      groups.push({ parent: claim, children: [] });
    }
  }

  return groups.map((group) => ({ parent: group.parent, children: group.children }));
}

/** True when two claims share a named-entity key or an anchor value. */
function sharesAnchor(parent: EvidenceClaim, claim: EvidenceClaim): boolean {
  const parentEntities = new Set(parent.entityKeys);
  if (claim.entityKeys.some((key) => parentEntities.has(key))) {
    return true;
  }
  const parentAnchors = new Set(parent.anchorValues);
  return claim.anchorValues.some((value) => parentAnchors.has(value));
}

/** Returns `parent` with `duplicate`'s citations and keys unioned in. */
function withUnionedEvidence(parent: EvidenceClaim, duplicate: EvidenceClaim): EvidenceClaim {
  return {
    ...parent,
    evidenceKinds: [...new Set([...parent.evidenceKinds, ...duplicate.evidenceKinds])],
    anchorValues: [...new Set([...parent.anchorValues, ...duplicate.anchorValues])],
    entityKeys: [...new Set([...parent.entityKeys, ...duplicate.entityKeys])].sort(),
    docIndexes: [...new Set([...parent.docIndexes, ...duplicate.docIndexes])].sort(
      (left, right) => left - right,
    ),
  };
}
