/**
 * Source relevance gate — the first hard filter of evidence-first synthesis.
 *
 * Before any clustering or source numbering, every fetched document is scored
 * against the {@link QueryProfile}. Documents that are clearly off-topic (a
 * NASA Mars page in an "EV sales" set, a nursing-home price list) contribute
 * **nothing** downstream: no claims, no facet rows, no source number. Each is
 * recorded as a {@link SourceExclusion} so the Brief can name it honestly under
 * a `source_excluded` notice — the Sources list then means "what this brief is
 * actually built on".
 *
 * ## Scoring
 *
 * Two length-robust signals decide relevance:
 *
 * - **must-match coverage** — the fraction of the query's informative lemmas
 *   present in the document (title + body). Set membership, so it does not
 *   decay as a document grows.
 * - **query similarity** — term-frequency cosine between the query and the
 *   document; rescues short, on-topic documents that use few of the exact
 *   query lemmas but are dominated by the query's subject terms.
 *
 * A document is kept when it clears *either* threshold. The thresholds are
 * deliberately conservative — the gate is built to drop the clearly-irrelevant,
 * not to second-guess borderline sources — and are tunable via {@link
 * RelevanceOptions}. Pure and deterministic: same docs + profile ⇒ same result.
 */

import type { TextAnalyzer } from '../analysis/text-analyzer.js';
import type { SynthesisDoc } from '../types.js';

import type { QueryProfile, SourceExclusion } from './types.js';

/**
 * Minimum fraction of must-match lemmas a document must contain to be kept.
 * Deliberately low: the gate favors recall (a borderline source is kept, and
 * the aggressive claim eligibility + facet-anchoring gates decide what of its
 * content actually surfaces), and only the clearly-irrelevant are dropped. A
 * single on-topic source that merely uses different vocabulary than the query
 * ("quarter" vs "quarterly") must survive.
 */
const DEFAULT_MIN_COVERAGE = 0.35;

/** Minimum query-similarity a document must reach to be kept. */
const DEFAULT_MIN_SIMILARITY = 0.1;

/** How many query terms to name in an exclusion reason. */
const REASON_TERM_LIMIT = 5;

/** Tunable relevance thresholds. */
export interface RelevanceOptions {
  /** Must-match coverage floor (default {@link DEFAULT_MIN_COVERAGE}). */
  readonly minCoverage?: number;
  /** Query-similarity floor (default {@link DEFAULT_MIN_SIMILARITY}). */
  readonly minSimilarity?: number;
}

/** Output of {@link gateRelevance}: which docs survive, and why the rest did not. */
export interface RelevanceResult {
  /** Indexes (into the input `docs`) of the relevance-passing documents. */
  readonly keptDocIndexes: readonly number[];
  /** Excluded documents with human-readable reasons, in input order. */
  readonly exclusions: readonly SourceExclusion[];
}

/**
 * Partitions the doc set into relevance-passing documents and excluded ones.
 *
 * @param docs - Fetched documents; array order is preserved.
 * @param query - The user's raw query (used for the similarity signal).
 * @param profile - The query profile carrying `mustMatchTerms`.
 * @param analyzer - Linguistic analyzer for lemmatization and similarity.
 * @param options - Optional threshold overrides.
 * @returns The kept doc indexes and the exclusions.
 */
export function gateRelevance(
  docs: readonly SynthesisDoc[],
  query: string,
  profile: QueryProfile,
  analyzer: TextAnalyzer,
  options: RelevanceOptions = {},
): RelevanceResult {
  const minCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const minSimilarity = options.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const mustMatch = profile.mustMatchTerms;

  const keptDocIndexes: number[] = [];
  const exclusions: SourceExclusion[] = [];

  docs.forEach((doc, docIndex) => {
    // No informative query terms → nothing to gate on; keep the document.
    if (mustMatch.length === 0) {
      keptDocIndexes.push(docIndex);
      return;
    }

    const lemmas = documentLemmas(doc, analyzer);
    const matched = mustMatch.filter((term) => lemmas.has(term));
    const coverage = matched.length / mustMatch.length;
    const similarity = analyzer.similarity(query, doc.text);

    if (coverage >= minCoverage || similarity >= minSimilarity) {
      keptDocIndexes.push(docIndex);
      return;
    }

    exclusions.push({
      docIndex,
      host: doc.host,
      reason: exclusionReason(mustMatch, matched.length),
    });
  });

  return { keptDocIndexes, exclusions };
}

/** The set of informative lemmas across a document's title and body. */
function documentLemmas(doc: SynthesisDoc, analyzer: TextAnalyzer): ReadonlySet<string> {
  const lemmas = new Set<string>();
  for (const sentence of analyzer.analyze(doc.text).sentences) {
    for (const lemma of sentence.lemmas) {
      lemmas.add(lemma);
    }
  }
  if (doc.title !== null) {
    for (const sentence of analyzer.analyze(doc.title).sentences) {
      for (const lemma of sentence.lemmas) {
        lemmas.add(lemma);
      }
    }
  }
  return lemmas;
}

/** Builds a human-readable exclusion reason naming the query terms. */
function exclusionReason(mustMatch: readonly string[], matchedCount: number): string {
  const termList = mustMatch.slice(0, REASON_TERM_LIMIT).join(', ');
  if (matchedCount === 0) {
    return `no overlap with query terms "${termList}"`;
  }
  return `weak overlap with query terms "${termList}" (matched ${matchedCount}/${mustMatch.length})`;
}
