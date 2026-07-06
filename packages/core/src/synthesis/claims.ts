/**
 * Claim extraction + salience ranking for deterministic synthesis.
 *
 * Candidate claims are sentences with quantitative signals (numbers,
 * currencies, dates), sentences carrying named entities repeated across
 * documents, and lede sentences. Every claim keeps the doc indexes that
 * evidence it — this is what makes deterministic citations *faithful by
 * construction*: a finding's citations are derived from where its claim was
 * actually observed, never invented afterwards.
 */

import { tfidfVectors, tokenize } from './similarity.js';
import type { ClaimKind, ExtractedClaim, SynthesisDoc } from './types.js';

/** Sentence-position decay factor used in the salience position weight. */
const POSITION_DECAY = 0.15;

/** How many leading sentences of a doc are treated as lede candidates. */
const LEDE_SENTENCES = 2;

/** Minimum informative tokens for a sentence to be a claim candidate. */
const MIN_CLAIM_TOKENS = 5;

/** Bounds keeping claims readable as findings. */
const MIN_CLAIM_CHARS = 25;
const MAX_CLAIM_CHARS = 400;

/** Cap on ranked claims returned; downstream budgets are far smaller. */
const MAX_CLAIMS = 50;

/** Fraction of a claim's informative tokens a doc must contain to support it. */
const SUPPORT_OVERLAP_THRESHOLD = 0.6;

/**
 * Quantitative-signal detector: currencies, percentages, magnitude words,
 * calendar years, and decimal/grouped numbers.
 */
const NUMBER_SIGNAL =
  /(?:[$€£¥]\s?\d)|(?:\d+(?:[.,]\d+)*\s?(?:%|percent|million|billion|trillion|dollars|usd|eur|gbp))|(?:\b(?:19|20)\d{2}\b)|(?:\b\d+(?:[.,]\d+)+\b)/iu;

/** Multi-word capitalized sequences treated as named-entity candidates. */
const ENTITY_PATTERN = /\b\p{Lu}[\p{Ll}\p{N}]+(?:\s+\p{Lu}[\p{Ll}\p{N}]+)+\b/gu;

/**
 * Splits text into trimmed sentences (Intl.Segmenter when available, with a
 * punctuation-based fallback). Exported for reuse by the deterministic
 * composer and the citation-faithfulness validator.
 *
 * @param text - Text to segment.
 * @returns Non-empty trimmed sentences in document order.
 */
export function splitSentences(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...segmenter.segment(text)]
      .map((item) => item.segment.trim())
      .filter((segment) => segment.length > 0);
  }

  return text
    .split(/(?<=[.!?])\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

interface CandidateClaim {
  readonly text: string;
  readonly kind: ClaimKind;
  readonly docIndex: number;
  readonly sentenceIndex: number;
}

/** Priority used when one sentence matches several detectors. */
const KIND_PRIORITY: Readonly<Record<ClaimKind, number>> = {
  number: 3,
  entity: 2,
  quote: 1,
  fact: 0,
};

/**
 * Extracts candidate claims from the doc set and ranks them by salience.
 *
 * Salience formula (per claim):
 *
 * ```
 * salience = supportCount × positionWeight × (1 + queryOverlap)
 * ```
 *
 * - `supportCount` — number of docs evidencing the claim (cross-doc
 *   corroboration dominates).
 * - `positionWeight` — `1 / (1 + sentenceIndex × 0.15)`; earlier sentences
 *   carry more editorial weight.
 * - `queryOverlap` — fraction of the query's informative terms present in
 *   the claim, applied as `1 + overlap` so claims without query terms are
 *   dampened rather than eliminated (a corroborated fact is still a fact).
 *
 * Ties break deterministically (evidence doc rank, then sentence order,
 * then text) so identical inputs always rank identically.
 *
 * @param docs - Extracted docs; array order = search rank.
 * @param query - The user's normalized question/topic.
 * @returns Ranked claims (highest salience first), each with >= 1 docIndex.
 */
export function extractClaims(
  docs: readonly SynthesisDoc[],
  query: string,
): readonly ExtractedClaim[] {
  if (docs.length === 0) {
    return [];
  }

  const sentencesByDoc = docs.map((doc) => splitSentences(doc.text));
  const docTokenSets = docs.map((doc) => new Set(tokenize(doc.text)));
  const vectors = tfidfVectors(docs.map((doc) => doc.text));
  const queryTerms = new Set(tokenize(query));

  const candidates: CandidateClaim[] = [
    ...numberCandidates(sentencesByDoc),
    ...entityCandidates(docs, sentencesByDoc),
    ...ledeCandidates(sentencesByDoc, vectors),
  ];

  // Dedupe near-identical sentences across docs; keep the most specific
  // kind and the best-ranked origin, merging evidence later via support.
  const byNormalizedText = new Map<string, CandidateClaim>();
  for (const candidate of candidates) {
    const key = normalizeClaimText(candidate.text);
    const existing = byNormalizedText.get(key);
    if (
      existing === undefined ||
      KIND_PRIORITY[candidate.kind] > KIND_PRIORITY[existing.kind] ||
      (KIND_PRIORITY[candidate.kind] === KIND_PRIORITY[existing.kind] &&
        candidate.docIndex < existing.docIndex)
    ) {
      byNormalizedText.set(key, candidate);
    }
  }

  const claims: ExtractedClaim[] = [];
  for (const candidate of byNormalizedText.values()) {
    const docIndexes = supportingDocs(candidate, docTokenSets);
    const overlap = queryOverlap(candidate.text, queryTerms);
    const positionWeight = 1 / (1 + candidate.sentenceIndex * POSITION_DECAY);
    const salience = docIndexes.length * positionWeight * (1 + overlap);

    claims.push({ text: candidate.text, docIndexes, kind: candidate.kind, salience });
  }

  return claims
    .sort(
      (left, right) =>
        right.salience - left.salience ||
        left.docIndexes[0]! - right.docIndexes[0]! ||
        left.text.localeCompare(right.text),
    )
    .slice(0, MAX_CLAIMS);
}

function isClaimSized(sentence: string): boolean {
  return sentence.length >= MIN_CLAIM_CHARS && sentence.length <= MAX_CLAIM_CHARS;
}

function numberCandidates(sentencesByDoc: readonly (readonly string[])[]): CandidateClaim[] {
  const found: CandidateClaim[] = [];
  sentencesByDoc.forEach((sentences, docIndex) => {
    sentences.forEach((sentence, sentenceIndex) => {
      if (!isClaimSized(sentence) || tokenize(sentence).length < MIN_CLAIM_TOKENS) {
        return;
      }
      if (NUMBER_SIGNAL.test(sentence)) {
        found.push({ text: sentence, kind: 'number', docIndex, sentenceIndex });
      }
    });
  });
  return found;
}

function entityCandidates(
  docs: readonly SynthesisDoc[],
  sentencesByDoc: readonly (readonly string[])[],
): CandidateClaim[] {
  // Entities qualifying as claim anchors must recur in >= 2 distinct docs.
  const docsByEntity = new Map<string, Set<number>>();
  docs.forEach((doc, docIndex) => {
    for (const match of doc.text.matchAll(ENTITY_PATTERN)) {
      const entity = match[0];
      const holder = docsByEntity.get(entity) ?? new Set<number>();
      holder.add(docIndex);
      docsByEntity.set(entity, holder);
    }
  });

  const repeated = [...docsByEntity.entries()].filter(([, holders]) => holders.size >= 2);

  const found: CandidateClaim[] = [];
  for (const [entity, holders] of repeated) {
    // Claim text = the earliest qualifying sentence mentioning the entity
    // in the best-ranked doc that contains it.
    const bestDoc = Math.min(...holders);
    const sentences = sentencesByDoc[bestDoc]!;
    const sentenceIndex = sentences.findIndex(
      (sentence) =>
        sentence.includes(entity) &&
        isClaimSized(sentence) &&
        tokenize(sentence).length >= MIN_CLAIM_TOKENS,
    );
    if (sentenceIndex === -1) {
      continue;
    }
    found.push({
      text: sentences[sentenceIndex]!,
      kind: 'entity',
      docIndex: bestDoc,
      sentenceIndex,
    });
  }
  return found;
}

function ledeCandidates(
  sentencesByDoc: readonly (readonly string[])[],
  vectors: readonly ReadonlyMap<string, number>[],
): CandidateClaim[] {
  const found: CandidateClaim[] = [];
  sentencesByDoc.forEach((sentences, docIndex) => {
    const vector = vectors[docIndex]!;
    let taken = 0;
    for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
      if (taken >= LEDE_SENTENCES) {
        break;
      }
      const sentence = sentences[sentenceIndex]!;
      const tokens = tokenize(sentence);
      if (!isClaimSized(sentence) || tokens.length < MIN_CLAIM_TOKENS) {
        continue;
      }
      // "High-TF-IDF lede": the sentence must actually carry weighted terms,
      // filtering boilerplate ledes ("Welcome to our site.").
      const weight = tokens.reduce((sum, token) => sum + (vector.get(token) ?? 0), 0);
      if (weight <= 0) {
        continue;
      }
      found.push({ text: sentence, kind: 'fact', docIndex, sentenceIndex });
      taken += 1;
    }
  });
  return found;
}

/**
 * A doc supports a claim when it contains most of the claim's informative
 * tokens ({@link SUPPORT_OVERLAP_THRESHOLD}). The originating doc always
 * counts, so every claim carries at least one evidence index.
 */
function supportingDocs(
  candidate: CandidateClaim,
  docTokenSets: readonly ReadonlySet<string>[],
): number[] {
  const claimTokens = [...new Set(tokenize(candidate.text))];
  const supporters: number[] = [];

  docTokenSets.forEach((docTokens, docIndex) => {
    if (docIndex === candidate.docIndex) {
      return;
    }
    if (claimTokens.length === 0) {
      return;
    }
    const hits = claimTokens.reduce((acc, token) => (docTokens.has(token) ? acc + 1 : acc), 0);
    if (hits / claimTokens.length >= SUPPORT_OVERLAP_THRESHOLD) {
      supporters.push(docIndex);
    }
  });

  return [candidate.docIndex, ...supporters].sort((left, right) => left - right);
}

function queryOverlap(sentence: string, queryTerms: ReadonlySet<string>): number {
  if (queryTerms.size === 0) {
    return 0;
  }
  const sentenceTokens = new Set(tokenize(sentence));
  let hits = 0;
  for (const term of queryTerms) {
    if (sentenceTokens.has(term)) {
      hits += 1;
    }
  }
  return hits / queryTerms.size;
}

function normalizeClaimText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}
