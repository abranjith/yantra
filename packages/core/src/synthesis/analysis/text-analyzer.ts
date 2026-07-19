/**
 * `TextAnalyzer` — the linguistic-analysis port for evidence-first synthesis.
 *
 * ## Why a port
 *
 * Deterministic synthesis needs to reason about *what a sentence is made of*
 * — is it grammatical, does it carry a money/percent/date figure, which
 * lemmas does it share with the query — not just how two blobs of text
 * overlap. Rather than sprinkle regexes and POS heuristics across the
 * pipeline, every stage asks a single injected `TextAnalyzer` for a
 * {@link DocAnalysis}. This keeps the analyzer swappable behind one seam:
 *
 * - {@link BaselineAnalyzer} — the migration-step implementation over the
 *   existing tokenizer / sentence splitter / regex detectors. Byte-stable
 *   with the pre-refactor pipeline, so it lands first and keeps the golden
 *   suite green while the new stages are built.
 * - `WinkAnalyzer` — the winkNLP-backed default (sentence boundary detection,
 *   POS tags, typed named-entity recognition). Local inference, no network,
 *   deterministic — it preserves the `--no-llm` and golden-test contracts.
 *
 * ## Determinism
 *
 * Every method is a pure function of its text input: same text in, deep-equal
 * analysis out, no I/O, clock, or randomness. This is what lets the evidence
 * pipeline stay golden-testable end to end.
 */

/**
 * Classification of a typed entity the analyzer locates in text.
 *
 * These are the analyzer's *surface* categories (what NER/regex detects);
 * the evidence pipeline maps them onto its own `EvidenceKind` vocabulary
 * (`cardinal → quantity`, `named → entity`) when gating claims.
 */
export type EntityKind = 'money' | 'percent' | 'date' | 'cardinal' | 'named';

/**
 * A typed entity located within a specific sentence of a document.
 */
export interface TypedEntity {
  /** Surface category (money / percent / date / cardinal / named). */
  readonly kind: EntityKind;
  /** The entity's surface text exactly as it appears in the source. */
  readonly text: string;
  /**
   * Canonical comparable form: numeric entities have separators/whitespace/
   * currency symbols stripped (`"$7,500" → "7500"`); named entities are
   * lower-cased and whitespace-collapsed. Used for cross-sentence matching.
   */
  readonly normalized: string;
  /** Index into {@link DocAnalysis.sentences} of the sentence carrying it. */
  readonly sentenceIndex: number;
}

/**
 * One analyzed sentence: its text plus token and lemma views.
 */
export interface AnalyzedSentence {
  /** Position of the sentence within the document (0-based). */
  readonly index: number;
  /** The sentence's trimmed surface text. */
  readonly text: string;
  /**
   * Informative tokens: lower-cased, stopwords and single characters dropped.
   * Duplicates preserved in reading order (used for overlap and length gates).
   */
  readonly tokens: readonly string[];
  /**
   * Lemmatized tokens, index-aligned with {@link tokens}. The baseline
   * analyzer has no morphology, so lemmas equal tokens there; the winkNLP
   * analyzer collapses inflections (`"sales" → "sale"`).
   */
  readonly lemmas: readonly string[];
  /**
   * True when the sentence carries negation ("Sales did **not** rise",
   * "Sales **never** rose") — winkNLP's sentence-level `negationFlag`. Consumed
   * by the near-duplicate merge guard so a claim never merges with its own
   * negation. The baseline analyzer has no negation model and always reports
   * `false`.
   */
  readonly negated: boolean;
  /**
   * Sentence sentiment in `[-1, 1]` (winkNLP's lexicon-based score; `0` is
   * neutral). A gate/rank signal only — never displayed in a Brief. The
   * baseline analyzer has no sentiment model and always reports `0`.
   */
  readonly sentiment: number;
}

/**
 * Immutable per-document analysis produced by a {@link TextAnalyzer}.
 *
 * Analyses are computed once per document and reused by every downstream
 * stage (relevance gate, eligibility gates, facet planner), so the analyzer
 * implementation is free to memoize.
 */
export interface DocAnalysis {
  /** The document's sentences in reading order. */
  readonly sentences: readonly AnalyzedSentence[];
  /** Every typed entity found across all sentences, in reading order. */
  readonly entities: readonly TypedEntity[];
  /**
   * Whether the sentence at `sentenceIndex` contains a finite (tensed) verb —
   * the grammaticality signal that separates real prose from headings and
   * navigation fragments (`"State-Wise EV Sales & Adoption"` → false).
   *
   * @param sentenceIndex - Index into {@link sentences}.
   * @returns True when the sentence carries a finite verb; false for
   *   out-of-range indexes and verbless fragments.
   */
  hasFiniteVerb(sentenceIndex: number): boolean;

  /**
   * Composite junk-likeness score for the sentence at `sentenceIndex`, in
   * `[0, 1]` — higher means more boilerplate/chrome-like. Derived from
   * per-token surface signals (capitalization density, stopword deficit,
   * long-word density) because winkNLP's `readabilityStats` is
   * document-scoped. Pure and deterministic like every other member. The
   * baseline analyzer always reports `0`.
   *
   * @param sentenceIndex - Index into {@link sentences}.
   * @returns Junk score in `[0, 1]`; `0` for out-of-range indexes.
   */
  junkScore(sentenceIndex: number): number;
}

/**
 * The linguistic-analysis port consumed by the evidence pipeline.
 *
 * Implementations must be pure and deterministic (see the module header).
 */
export interface TextAnalyzer {
  /**
   * Analyzes one document's text into sentences, typed entities, and
   * per-sentence grammaticality.
   *
   * @param text - The document's extracted plain text.
   * @returns The document analysis (empty sentences/entities for empty text).
   */
  analyze(text: string): DocAnalysis;

  /**
   * Similarity between two texts in `[0, 1]` — used for source relevance
   * scoring and near-duplicate claim merging. Symmetric; `0` when either side
   * carries no informative tokens.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Similarity score in `[0, 1]`.
   */
  similarity(textA: string, textB: string): number;

  /**
   * Containment coefficient between two texts in `[0, 1]`: the fraction of
   * the *smaller* text's informative-lemma mass also present in the larger
   * one. `1` means the smaller text is (lexically) fully inside the larger —
   * the signal cosine misses when a short claim restates a fragment of a
   * long one. Symmetric; `0` when either side carries no informative tokens.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Containment coefficient in `[0, 1]`.
   *
   * @example
   * analyzer.containment(
   *   'Norway stand one win from a semi-final.',
   *   'Match previews: Norway stand one win from a semi-final.',
   * ); // ≈ 1 — the first text is contained in the second
   */
  containment(textA: string, textB: string): number;
}
