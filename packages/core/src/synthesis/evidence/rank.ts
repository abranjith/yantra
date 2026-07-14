/**
 * In-house TextRank centrality and MMR (Maximal Marginal Relevance) selection
 * for deterministic synthesis composition.
 *
 * Both are pure functions over an injected similarity callback (the
 * {@link TextAnalyzer.similarity} seam), so they inherit the pipeline's
 * determinism guarantees: a **fixed** iteration count (no float-convergence
 * dependent behavior) and totally ordered tie-breaks (input index).
 *
 * Kept in-repo deliberately (no new dependency): at Brief scale — dozens of
 * claims, not thousands of documents — both algorithms are a few dozen lines
 * over the existing cosine machinery.
 */

/** Options for {@link textRank}. */
export interface TextRankOptions {
  /** Damping factor (probability of following the similarity graph). */
  readonly damping?: number;
  /** Fixed number of power iterations (determinism over convergence). */
  readonly iterations?: number;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITERATIONS = 30;

/**
 * TextRank centrality scores for a set of texts.
 *
 * Builds a fully connected similarity graph and runs a fixed number of
 * PageRank-style power iterations. Higher score = the text is more "central"
 * (restates what many other texts also say), which is the classic extractive
 * summarization signal.
 *
 * @param texts - The texts to score (order preserved; result index-aligned).
 * @param similarity - Symmetric similarity in `[0, 1]` between two texts.
 * @param options - Damping/iteration overrides.
 * @returns One score per text; uniform scores when no pair is similar.
 *
 * @example
 * const scores = textRank(claims.map((c) => c.text), (a, b) => analyzer.similarity(a, b));
 * const mostCentral = claims[scores.indexOf(Math.max(...scores))];
 */
export function textRank(
  texts: readonly string[],
  similarity: (textA: string, textB: string) => number,
  options: TextRankOptions = {},
): number[] {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const count = texts.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [1];
  }

  // Symmetric weight matrix over the injected similarity.
  const weights: number[][] = texts.map(() => new Array<number>(count).fill(0));
  for (let row = 0; row < count; row += 1) {
    for (let col = row + 1; col < count; col += 1) {
      const weight = similarity(texts[row]!, texts[col]!);
      weights[row]![col] = weight;
      weights[col]![row] = weight;
    }
  }
  const outSums = weights.map((row) => row.reduce((acc, weight) => acc + weight, 0));

  let scores = new Array<number>(count).fill(1 / count);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Array<number>(count).fill((1 - damping) / count);
    for (let node = 0; node < count; node += 1) {
      for (let other = 0; other < count; other += 1) {
        if (other === node || outSums[other] === 0) {
          continue;
        }
        next[node]! += damping * scores[other]! * (weights[other]![node]! / outSums[other]!);
      }
    }
    scores = next;
  }

  return scores;
}

/**
 * Greedy MMR selection: picks up to `k` items balancing relevance against
 * redundancy with what is already selected.
 *
 * Relevance values are normalized by their maximum internally, so any
 * non-negative scale (salience, TextRank score) can be passed directly.
 * Ties break on input index — fully deterministic.
 *
 * @param items - Candidate items in a stable order.
 * @param relevance - Non-negative relevance score per item.
 * @param similarity - Pairwise similarity in `[0, 1]` between two items.
 * @param lambda - Relevance weight in `[0, 1]` (`1` = pure relevance).
 * @param k - Maximum number of items to select.
 * @returns Selected items in selection (relevance-diverse) order.
 *
 * @example
 * const findings = selectMmr(groups, (g) => g.parent.salience,
 *   (a, b) => analyzer.similarity(a.parent.text, b.parent.text), 0.7, budget);
 */
export function selectMmr<T>(
  items: readonly T[],
  relevance: (item: T) => number,
  similarity: (left: T, right: T) => number,
  lambda: number,
  k: number,
): T[] {
  if (items.length === 0 || k <= 0) {
    return [];
  }

  const scores = items.map((item) => relevance(item));
  const maxScore = Math.max(...scores);
  const normalized = maxScore > 0 ? scores.map((score) => score / maxScore) : scores.map(() => 0);

  const remaining = new Set<number>(items.map((_, index) => index));
  const selected: number[] = [];

  while (selected.length < k && remaining.size > 0) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const index of remaining) {
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, similarity(items[index]!, items[chosen]!));
      }
      const score = lambda * normalized[index]! - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex === -1) {
      break;
    }
    remaining.delete(bestIndex);
    selected.push(bestIndex);
  }

  return selected.map((index) => items[index]!);
}
