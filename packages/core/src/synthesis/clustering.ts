/**
 * Near-duplicate source clustering for the synthesis stage.
 *
 * Syndicated copies of the same article (identical or near-identical text on
 * two hosts) must not appear as two independent sources in a Brief — they
 * would inflate apparent cross-source support. Docs whose TF-IDF cosine
 * similarity meets {@link CLUSTER_SIMILARITY_THRESHOLD} are grouped into one
 * {@link SourceCluster}; each cluster contributes exactly one numbered
 * `Source` entry, represented by its highest-search-rank member.
 *
 * Determinism: docs are processed in a canonical order (sorted by normalized
 * URL) before greedy clustering, so cluster *membership* is invariant under
 * input shuffling; representatives and numbering then derive from search
 * rank (input array order). No vector DB — see `similarity.ts` (plan §3:
 * vector search is explicitly still deferred at this scale).
 */

import type { BriefSource } from '@yantra/protocol';

import { cosineSimilarity, tfidfVectors } from './similarity.js';
import type { SourceCluster, SynthesisDoc } from './types.js';

/**
 * Cosine threshold (TF-IDF vectors) above which two docs are treated as
 * near-duplicates. 0.85 is deliberately conservative: syndicated copies and
 * mirror pages score well above it, while distinct articles on the same
 * topic stay comfortably below.
 */
export const CLUSTER_SIMILARITY_THRESHOLD = 0.85;

/** Output of {@link clusterSources}. */
export interface ClusteringResult {
  /** Clusters ordered by their representative's search rank. */
  readonly clusters: readonly SourceCluster[];
  /** One numbered Brief source per cluster (contiguous n starting at 1). */
  readonly sources: readonly BriefSource[];
  /** Doc index → assigned citation number (sources[].n) of its cluster. */
  readonly clusterNumberByDoc: readonly number[];
}

/** The URL identity used for exact-duplicate merging (final_url wins). */
function normalizedUrl(doc: SynthesisDoc): string {
  return doc.finalUrl ?? doc.url;
}

/**
 * Groups near-duplicate docs and derives the numbered source list.
 *
 * Rules:
 * - Docs sharing a normalized URL (`finalUrl ?? url`) are always merged —
 *   the Brief schema refuses duplicate source URLs.
 * - Docs with cosine similarity >= {@link CLUSTER_SIMILARITY_THRESHOLD}
 *   are merged (greedy, canonical processing order).
 * - Representative = the member with the best search rank (lowest index);
 *   cluster numbering follows representative rank, so `n` is contiguous
 *   from 1 in rank order.
 *
 * @param docs - Extracted docs; array order = search rank.
 * @returns Clusters, the deduplicated numbered sources, and the doc→n map.
 */
export function clusterSources(docs: readonly SynthesisDoc[]): ClusteringResult {
  if (docs.length === 0) {
    return { clusters: [], sources: [], clusterNumberByDoc: [] };
  }

  const vectors = tfidfVectors(docs.map((doc) => doc.text));

  // Canonical processing order keeps greedy merges independent of input
  // order (sort-before-cluster); ties broken by index for total ordering.
  const canonicalOrder = docs
    .map((doc, index) => ({ index, key: normalizedUrl(doc) }))
    .sort((left, right) => left.key.localeCompare(right.key) || left.index - right.index)
    .map((entry) => entry.index);

  interface MutableCluster {
    members: number[];
    similarity: number;
  }

  const clusters: MutableCluster[] = [];
  const clusterByUrl = new Map<string, MutableCluster>();

  for (const docIndex of canonicalOrder) {
    const url = normalizedUrl(docs[docIndex]!);

    const urlMatch = clusterByUrl.get(url);
    if (urlMatch !== undefined) {
      urlMatch.members.push(docIndex);
      urlMatch.similarity = 1;
      continue;
    }

    let joined: MutableCluster | null = null;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      // Compare against the cluster's canonical seed (first member added).
      const seed = cluster.members[0]!;
      const similarity = cosineSimilarity(vectors[docIndex]!, vectors[seed]!);
      if (similarity >= CLUSTER_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
        joined = cluster;
        bestSimilarity = similarity;
      }
    }

    if (joined !== null) {
      joined.members.push(docIndex);
      joined.similarity = Math.max(joined.similarity, bestSimilarity);
      clusterByUrl.set(url, joined);
      continue;
    }

    const fresh: MutableCluster = { members: [docIndex], similarity: 1 };
    clusters.push(fresh);
    clusterByUrl.set(url, fresh);
  }

  // Rank-order everything: members within a cluster, then clusters by their
  // representative (best-ranked member). n = 1..N follows this order.
  const ranked: SourceCluster[] = clusters
    .map((cluster) => {
      const members = [...cluster.members].sort((left, right) => left - right);
      return { representative: members[0]!, members, similarity: cluster.similarity };
    })
    .sort((left, right) => left.representative - right.representative);

  const clusterNumberByDoc: number[] = new Array<number>(docs.length).fill(0);
  const sources: BriefSource[] = ranked.map((cluster, position) => {
    const n = position + 1;
    for (const member of cluster.members) {
      clusterNumberByDoc[member] = n;
    }

    const representative = docs[cluster.representative]!;
    return {
      n,
      url: representative.url,
      final_url: representative.finalUrl,
      host: representative.host,
      title: representative.title,
      // The deterministic pipeline carries evidence in key findings, not
      // per-source snippets; agentic Briefs fill excerpt from the run ledger.
      excerpt: null,
      fetched_at: representative.fetchedAt,
      published_at: representative.publishedAt,
    };
  });

  return { clusters: ranked, sources, clusterNumberByDoc };
}
