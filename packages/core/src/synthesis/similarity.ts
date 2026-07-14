/**
 * Small pure TF-IDF / cosine-similarity utility for deterministic synthesis.
 *
 * Kept in-repo on purpose (plan §3): near-duplicate detection at ask/research
 * scale (a handful of documents) needs neither a vector database nor an
 * external similarity dependency — a term-frequency vectorizer over the doc
 * set is sufficient, deterministic, and fully golden-testable. Vector search
 * remains explicitly deferred.
 *
 * All functions are pure: same inputs, same outputs, no I/O.
 */

/** A sparse term-weight vector (term → TF-IDF weight). */
export type TermVector = ReadonlyMap<string, number>;

/**
 * English stopwords excluded from tokenization. Deliberately small: the goal
 * is dampening boilerplate overlap, not linguistic perfection.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'after',
  'all',
  'also',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'more',
  'most',
  'no',
  'not',
  'of',
  'on',
  'one',
  'or',
  'our',
  'she',
  'so',
  'some',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'was',
  'we',
  'were',
  'what',
  'when',
  'which',
  'who',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

/**
 * Tokenizes text for similarity/claim analysis: lowercase, split on
 * non-alphanumerics (Unicode-aware, so multi-byte scripts survive), drop
 * one-character tokens and stopwords.
 *
 * @param text - Raw text to tokenize.
 * @returns Token list in text order (duplicates preserved).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * Builds TF-IDF vectors for a document set.
 *
 * TF is the raw term count normalized by document length; IDF is the
 * smoothed `log((1 + N) / (1 + df)) + 1` so terms present in every doc
 * still contribute a little (important with N as small as 2).
 *
 * @param docs - The document texts; the returned array is index-aligned.
 * @returns One sparse term vector per document.
 */
export function tfidfVectors(docs: readonly string[]): TermVector[] {
  const tokenized = docs.map((doc) => tokenize(doc));

  const documentFrequency = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const total = docs.length;

  return tokenized.map((tokens) => {
    const vector = new Map<string, number>();
    if (tokens.length === 0) {
      return vector;
    }

    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    for (const [term, count] of counts) {
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log((1 + total) / (1 + df)) + 1;
      vector.set(term, (count / tokens.length) * idf);
    }

    return vector;
  });
}

/**
 * Containment coefficient between two term bags: the shared term mass divided
 * by the smaller bag's mass, in `[0, 1]`.
 *
 * Where cosine asks "how similar are these texts overall?", containment asks
 * "is the smaller text essentially inside the larger one?" — which is the
 * right question for detecting a claim that restates a fragment of another
 * (cosine is diluted by everything else the longer text says).
 *
 * @param left - First term bag (term → count or weight).
 * @param right - Second term bag.
 * @returns Shared mass ÷ smaller bag's mass; `0` when either bag is empty.
 */
export function bagContainment(left: TermVector, right: TermVector): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let leftMass = 0;
  for (const weight of left.values()) {
    leftMass += weight;
  }
  let rightMass = 0;
  for (const weight of right.values()) {
    rightMass += weight;
  }

  const [smaller, larger] = leftMass <= rightMass ? [left, right] : [right, left];
  let shared = 0;
  for (const [term, weight] of smaller) {
    const other = larger.get(term);
    if (other !== undefined) {
      shared += Math.min(weight, other);
    }
  }

  const smallerMass = Math.min(leftMass, rightMass);
  return smallerMass === 0 ? 0 : shared / smallerMass;
}

/**
 * Cosine similarity between two sparse term vectors.
 *
 * @param left - First term vector.
 * @param right - Second term vector.
 * @returns Similarity in [0, 1]; 0 when either vector is empty.
 */
export function cosineSimilarity(left: TermVector, right: TermVector): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];

  let dot = 0;
  for (const [term, weight] of smaller) {
    const other = larger.get(term);
    if (other !== undefined) {
      dot += weight * other;
    }
  }

  if (dot === 0) {
    return 0;
  }

  let leftNorm = 0;
  for (const weight of left.values()) {
    leftNorm += weight * weight;
  }
  let rightNorm = 0;
  for (const weight of right.values()) {
    rightNorm += weight * weight;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
