/**
 * `BaselineAnalyzer` — the migration-step {@link TextAnalyzer} implementation.
 *
 * ## Migration strategy
 *
 * Evidence-first synthesis introduces the {@link TextAnalyzer} seam so the
 * pipeline can be rewired one stage at a time without a flag-day rewrite. This
 * baseline implementation is deliberately **behavior-stable** with the
 * pre-refactor code: its sentence segmentation is the original
 * {@link splitSentences}, its tokens are the original `tokenize`, and its
 * similarity is the original TF-IDF cosine. Landing it first lets the golden
 * Brief suite stay byte-identical while the new evidence stages are built and
 * tested against a real port. The winkNLP analyzer then becomes the default
 * (see `wink-analyzer.ts`), shifting sentence boundaries and entity typing to
 * a linguistic model — at which point the goldens are intentionally
 * regenerated.
 *
 * Because it has no morphology or POS model, the baseline approximates the two
 * capabilities winkNLP provides natively: lemmas equal tokens, and
 * {@link DocAnalysis.hasFiniteVerb} is a punctuation/verb-lexicon heuristic
 * rather than a true POS check. These approximations are only consulted by the
 * new gating stages, which run under the winkNLP default — the baseline
 * remains the always-available, network-free fallback.
 *
 * Purity: `analyze`/`similarity` are pure functions of their text inputs.
 */

import { bagContainment, cosineSimilarity, tfidfVectors, tokenize } from '../similarity.js';

import { normalizeDate, normalizeNamed, normalizeNumeric } from './normalize.js';
import type {
  AnalyzedSentence,
  DocAnalysis,
  EntityKind,
  TextAnalyzer,
  TypedEntity,
} from './text-analyzer.js';

/**
 * Splits text into trimmed sentences (Intl.Segmenter when available, with a
 * punctuation-based fallback).
 *
 * Owned by the analyzer layer: the deterministic composer and the
 * citation-faithfulness validator reach sentence structure through a
 * {@link TextAnalyzer}, but this primitive stays exported for the small number
 * of call sites that only need raw segmentation.
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

/** First-class currency amounts ("$328", "€ 1.299,00", "£45.50"). */
const MONEY_PATTERN = /[$€£¥]\s?\d[\d,.]*/gu;

/** Percentages, symbol or spelled ("15%", "3.5 %", "28 percent"). */
const PERCENT_PATTERN = /\d+(?:[.,]\d+)?\s?(?:%|percent\b)/giu;

/** Calendar dates: quarters, month-years, and bare years. */
const DATE_PATTERN =
  /\bQ[1-4]\s?(?:19|20)?\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b|\b(?:19|20)\d{2}\b/giu;

/** Grouped/decimal numbers and magnitude figures ("1,299", "3.5 million"). */
const CARDINAL_PATTERN =
  /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s?(?:million|billion|trillion|thousand)\b|\b\d+(?:\.\d+)?\b/giu;

/** Multi-word capitalized sequences treated as named-entity candidates. */
const NAMED_PATTERN = /\b\p{Lu}[\p{Ll}\p{N}]+(?:\s+\p{Lu}[\p{Ll}\p{N}]+)+\b/gu;

/**
 * Finite-verb lexicon (auxiliaries, copulas, common reporting/measure verbs).
 * Matched against raw sentence text because most are stopwords stripped from
 * the token view. A heading like "State-Wise EV Sales & Adoption" contains
 * none of these, so it fails the grammaticality gate.
 */
const FINITE_VERB_PATTERN =
  /\b(?:is|are|was|were|be|been|being|am|has|have|had|do|does|did|will|would|can|could|may|might|shall|should|must|say|says|said|report|reports|reported|announce|announces|announced|grow|grows|grew|grown|rise|rises|rose|risen|fall|falls|fell|fallen|reach|reaches|reached|increase|increases|increased|decrease|decreases|decreased|decline|declines|declined|expect|expects|expected|estimate|estimates|estimated|plan|plans|planned|include|includes|included|offer|offers|offered|cost|costs|sell|sells|sold|find|finds|found|show|shows|showed|remain|remains|remained|become|becomes|became|make|makes|made|according)\b/iu;

interface Detector {
  readonly kind: EntityKind;
  readonly pattern: RegExp;
  readonly normalize: (surface: string) => string;
}

/**
 * Detectors in priority order. Higher-priority matches claim their character
 * span first, so a year already typed as `date` is not re-typed as `cardinal`.
 */
const DETECTORS: readonly Detector[] = [
  { kind: 'money', pattern: MONEY_PATTERN, normalize: normalizeNumeric },
  { kind: 'percent', pattern: PERCENT_PATTERN, normalize: normalizeNumeric },
  { kind: 'date', pattern: DATE_PATTERN, normalize: normalizeDate },
  { kind: 'cardinal', pattern: CARDINAL_PATTERN, normalize: normalizeNumeric },
  { kind: 'named', pattern: NAMED_PATTERN, normalize: normalizeNamed },
];

/** Extracts typed entities from one sentence, resolving span overlaps by priority. */
function extractEntities(sentence: string, sentenceIndex: number): TypedEntity[] {
  const claimed: { start: number; end: number }[] = [];
  const overlaps = (start: number, end: number): boolean =>
    claimed.some((span) => start < span.end && end > span.start);

  const located: { entity: TypedEntity; start: number }[] = [];
  for (const detector of DETECTORS) {
    // Fresh lastIndex per sentence: the patterns are module-level /g regexes.
    detector.pattern.lastIndex = 0;
    for (const match of sentence.matchAll(detector.pattern)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (overlaps(start, end)) {
        continue;
      }
      claimed.push({ start, end });
      located.push({
        entity: {
          kind: detector.kind,
          text: match[0].trim(),
          normalized: detector.normalize(match[0]),
          sentenceIndex,
        },
        start,
      });
    }
  }

  return located.sort((left, right) => left.start - right.start).map((item) => item.entity);
}

/**
 * The behavior-stable baseline analyzer.
 *
 * Stateless and cheap to construct; a fresh instance per synthesis run is
 * fine (no module-level singleton).
 */
export class BaselineAnalyzer implements TextAnalyzer {
  /**
   * Analyzes text into sentences (original segmentation), informative tokens
   * (original tokenizer, reused as lemmas), and regex-typed entities.
   *
   * @param text - The document's extracted plain text.
   * @returns The document analysis.
   */
  public analyze(text: string): DocAnalysis {
    const sentenceTexts = splitSentences(text);
    const sentences: AnalyzedSentence[] = sentenceTexts.map((sentenceText, index) => {
      const tokens = tokenize(sentenceText);
      return { index, text: sentenceText, tokens, lemmas: tokens };
    });

    const entities: TypedEntity[] = sentences.flatMap((sentence) =>
      extractEntities(sentence.text, sentence.index),
    );

    return {
      sentences,
      entities,
      hasFiniteVerb: (sentenceIndex: number): boolean => {
        const sentence = sentences[sentenceIndex];
        if (sentence === undefined) {
          return false;
        }
        if (FINITE_VERB_PATTERN.test(sentence.text)) {
          return true;
        }
        // Fallback grammaticality proxy: terminal punctuation plus enough
        // informative tokens separates prose from Title-Case headings.
        return /[.!?]["')\]]?\s*$/u.test(sentence.text) && sentence.tokens.length >= 6;
      },
    };
  }

  /**
   * TF-IDF cosine similarity over the two texts as a two-document corpus.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Cosine similarity in `[0, 1]`.
   */
  public similarity(textA: string, textB: string): number {
    const [vectorA, vectorB] = tfidfVectors([textA, textB]);
    return cosineSimilarity(vectorA!, vectorB!);
  }

  /**
   * Token-bag containment coefficient between two texts, in `[0, 1]` (shared
   * token mass ÷ smaller bag's mass; tokens double as lemmas here).
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Containment coefficient; `0` when either side has no tokens.
   */
  public containment(textA: string, textB: string): number {
    return bagContainment(countBag(tokenize(textA)), countBag(tokenize(textB)));
  }
}

/** Builds a term-frequency bag from a token list. */
function countBag(tokens: readonly string[]): ReadonlyMap<string, number> {
  const bag = new Map<string, number>();
  for (const token of tokens) {
    bag.set(token, (bag.get(token) ?? 0) + 1);
  }
  return bag;
}
