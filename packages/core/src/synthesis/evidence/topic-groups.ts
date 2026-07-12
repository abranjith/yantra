/**
 * Topic grouping for deterministic synthesis findings.
 *
 * The evidence set remains the flat, ranked truth. Composition can then group
 * nearby claims so the rendered Brief reads like an editor organized it:
 * highest-salience claim as the parent, lower-salience related claims as
 * children. The threshold is deliberately below the numeric duplicate merge
 * floor: related-but-distinct claims should nest, while duplicates should have
 * already merged.
 */

import type { TextAnalyzer } from '../analysis/text-analyzer.js';

import type { EvidenceClaim } from './types.js';

/** Topic similarity threshold: below merge floors, above incidental overlap. */
export const TOPIC_THRESHOLD = 0.4;

/** Maximum child findings shown directly under a parent finding. */
export const MAX_CHILDREN_PER_FINDING = 2;

export interface TopicGroup {
  /** Highest-salience member and display parent. */
  readonly parent: EvidenceClaim;
  /** Remaining members in rank order. */
  readonly children: readonly EvidenceClaim[];
}

/**
 * Greedily groups claims by similarity to each group's parent.
 *
 * @param claims - Flat salience-ranked claims.
 * @param analyzer - Text similarity implementation.
 * @param threshold - Minimum parent similarity to join a group.
 * @returns Rank-ordered groups.
 */
export function groupClaimsByTopic(
  claims: readonly EvidenceClaim[],
  analyzer: TextAnalyzer,
  threshold = TOPIC_THRESHOLD,
): readonly TopicGroup[] {
  const groups: TopicGroup[] = [];
  for (const claim of claims) {
    const group = groups.find(
      (candidate) => analyzer.similarity(candidate.parent.text, claim.text) >= threshold,
    );
    if (group === undefined) {
      groups.push({ parent: claim, children: [] });
    } else {
      (group.children as EvidenceClaim[]).push(claim);
    }
  }
  return groups;
}
