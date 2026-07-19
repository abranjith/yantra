/**
 * `WinkAnalyzer` — the default {@link TextAnalyzer}, backed by winkNLP.
 *
 * ## Why winkNLP, and why it keeps the contracts intact
 *
 * The evidence gates need real linguistic signal, not regexes: sentence
 * boundary detection, POS tags (to tell a grammatical sentence from a heading),
 * typed named-entity recognition (money / percent / date / cardinal), plus the
 * `negation` and `sentiment` pipe stages feeding the per-sentence
 * `negated`/`sentiment` fields and the derived per-sentence junk score.
 * winkNLP (`wink-nlp` + `wink-eng-lite-web-model`) provides all of this as
 * **local, offline, rule-and-model inference** — no network, no service, and
 * fully deterministic (same text in, deep-equal analysis out). That is exactly
 * what the `--no-llm` guarantee and the golden-Brief suite require: swapping
 * the analyzer changes *what* sentences and entities are found, but the
 * pipeline downstream stays a pure function, so the goldens simply get
 * regenerated once and pinned again.
 *
 * ## Named entities
 *
 * The lite web model's NER covers the numeric/temporal types (MONEY, PERCENT,
 * DATE, CARDINAL) but not PERSON/ORG/GPE. Named entities are therefore derived
 * from POS: maximal runs of proper-noun (`PROPN`) tokens ("Cox Automotive").
 *
 * ## Caching
 *
 * The winkNLP engine (model + pipeline) is loaded once per process and shared
 * — it is immutable here (no `learnCustomEntities`), so sharing is safe and
 * avoids re-parsing the multi-megabyte model. Per-document analyses are
 * memoized on the instance so a document that several stages inspect is only
 * run through the pipeline once (the analysis-cache requirement).
 */

import model from 'wink-eng-lite-web-model';
import winkNLP from 'wink-nlp';
import type { ItemEntity, ItemSentence, ItemToken, ItsFunction, WinkMethods } from 'wink-nlp';

import { bagContainment, cosineSimilarity } from '../similarity.js';

/*
 * winkNLP's `its` accessors (its.pos, its.normal, its.type, its.lemma, ...) are
 * standalone helper functions passed to `out()`; they never reference `this`,
 * so passing them unbound is safe and idiomatic winkNLP usage.
 */
/* eslint-disable @typescript-eslint/unbound-method */

import { normalizeDate, normalizeNamed, normalizeNumeric } from './normalize.js';
import type {
  AnalyzedSentence,
  DocAnalysis,
  EntityKind,
  TextAnalyzer,
  TypedEntity,
} from './text-analyzer.js';

/**
 * winkNLP pipeline stages the evidence gates depend on. `negation` and
 * `sentiment` populate the per-sentence `negationFlag`/`sentiment` accessors
 * (they only fill sentence-tuple slots — sbd/pos/ner output is unaffected).
 */
const PIPE: readonly string[] = ['sbd', 'pos', 'ner', 'cer', 'negation', 'sentiment'];

/** Maps winkNLP NER entity types onto the analyzer's {@link EntityKind}. */
const ENTITY_KIND_BY_WINK: Readonly<Record<string, EntityKind>> = {
  MONEY: 'money',
  PERCENT: 'percent',
  DATE: 'date',
  CARDINAL: 'cardinal',
};

/** POS tags treated as carrying a finite (tensed) verb. */
const FINITE_VERB_POS: ReadonlySet<string> = new Set(['VERB', 'AUX']);

/** POS tags dropped from the informative token view (punctuation/symbols). */
const NON_INFORMATIVE_POS: ReadonlySet<string> = new Set(['PUNCT', 'SYM', 'SPACE', 'X']);

/**
 * Junk-score formula weights and bounds (see the FEAT-WI-003 spike findings).
 * The score blends three `[0, 1]` word-token ratios:
 *
 * - capitalization density of non-initial words (nav/title chrome is
 *   Title-Case-dense) — weight {@link JUNK_CAP_WEIGHT};
 * - stopword deficit — real prose carries roughly 20–60% stopwords, link glue
 *   nearly none; full credit at {@link JUNK_STOPWORD_FLOOR} stopword ratio —
 *   weight {@link JUNK_STOP_WEIGHT};
 * - long-word density (`normal` length ≥ {@link JUNK_LONG_WORD_CHARS};
 *   SEO/gibberish glue) — weight {@link JUNK_LONG_WEIGHT}.
 *
 * Probe separation on junk/prose fixture pairs: junk 0.45–0.90, prose
 * 0.00–0.27.
 */
const JUNK_CAP_WEIGHT = 0.5;
const JUNK_STOP_WEIGHT = 0.4;
const JUNK_LONG_WEIGHT = 0.1;
const JUNK_STOPWORD_FLOOR = 0.25;
const JUNK_LONG_WORD_CHARS = 12;

/**
 * Process-wide winkNLP engine. Lazily initialized and shared because the model
 * is large and immutable in this usage; not a mutable singleton (each
 * `readDoc` returns a fresh, independent document).
 */
let sharedEngine: WinkMethods | null = null;

/** Returns the shared winkNLP engine, loading the model on first use. */
function winkEngine(): WinkMethods {
  sharedEngine ??= winkNLP(model, [...PIPE]);
  return sharedEngine;
}

/**
 * The default analyzer: winkNLP sentence/POS/NER analysis behind the
 * {@link TextAnalyzer} port.
 */
export class WinkAnalyzer implements TextAnalyzer {
  private readonly engine: WinkMethods;

  private readonly cache = new Map<string, DocAnalysis>();

  /**
   * @param engine - Optional injected winkNLP engine (defaults to the shared
   *   process engine). Present for test isolation.
   */
  public constructor(engine: WinkMethods = winkEngine()) {
    this.engine = engine;
  }

  /**
   * Analyzes text into sentences (winkNLP SBD), informative tokens/lemmas
   * (POS-filtered, lemmatized), and typed entities (NER + PROPN runs). Result
   * is memoized per text.
   *
   * @param text - The document's extracted plain text.
   * @returns The document analysis.
   */
  public analyze(text: string): DocAnalysis {
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    const { its } = this.engine;
    const doc = this.engine.readDoc(text);
    // `its.lemma` takes the model addons, so it does not fit winkNLP's own
    // `out()` overload set (a typings quirk); the cast pins its string result.
    const lemmaFn = its.lemma as unknown as ItsFunction<string>;

    const sentences: AnalyzedSentence[] = [];
    const finiteVerbBySentence: boolean[] = [];
    const junkScoreBySentence: number[] = [];
    const entities: TypedEntity[] = [];

    doc.sentences().each((sentence: ItemSentence, sentenceIndex: number) => {
      const tokens: string[] = [];
      const lemmas: string[] = [];
      let hasFiniteVerb = false;
      let propnRun: string[] = [];
      let wordCount = 0;
      let capitalizedNonInitial = 0;
      let stopwordCount = 0;
      let longWordCount = 0;

      const flushNamed = (): void => {
        if (propnRun.length > 0) {
          const surface = propnRun.join(' ');
          entities.push({
            kind: 'named',
            text: surface,
            normalized: normalizeNamed(surface),
            sentenceIndex,
          });
          propnRun = [];
        }
      };

      sentence.tokens().each((token: ItemToken) => {
        const pos = String(token.out(its.pos));

        if (FINITE_VERB_POS.has(pos)) {
          hasFiniteVerb = true;
        }

        if (pos === 'PROPN') {
          propnRun.push(String(token.out()));
        } else {
          flushNamed();
        }

        const isStopword = token.out(its.stopWordFlag) === true;
        const isWord = !NON_INFORMATIVE_POS.has(pos);
        const normal = String(token.out(its.normal));

        if (isWord) {
          if (wordCount > 0 && String(token.out(its.shape)).startsWith('X')) {
            capitalizedNonInitial += 1;
          }
          if (isStopword) {
            stopwordCount += 1;
          }
          if (normal.length >= JUNK_LONG_WORD_CHARS) {
            longWordCount += 1;
          }
          wordCount += 1;
        }

        if (!isWord || isStopword) {
          return;
        }
        if (normal.length <= 1) {
          return;
        }
        tokens.push(normal);
        lemmas.push(String(token.out(lemmaFn)).toLowerCase());
      });
      flushNamed();

      sentences.push({
        index: sentenceIndex,
        text: sentence.out(),
        tokens,
        lemmas,
        negated: sentence.out(its.negationFlag) === true,
        sentiment: Number(sentence.out(its.sentiment)),
      });
      finiteVerbBySentence[sentenceIndex] = hasFiniteVerb;
      junkScoreBySentence[sentenceIndex] = junkScoreFor(
        wordCount,
        capitalizedNonInitial,
        stopwordCount,
        longWordCount,
      );
    });

    doc.entities().each((entity: ItemEntity) => {
      const kind = ENTITY_KIND_BY_WINK[String(entity.out(its.type))];
      if (kind === undefined) {
        return;
      }
      const surface = String(entity.out());
      entities.push({
        kind,
        text: surface,
        normalized: kind === 'date' ? normalizeDate(surface) : normalizeNumeric(surface),
        sentenceIndex: entity.parentSentence().index(),
      });
    });

    const analysis: DocAnalysis = {
      sentences,
      entities,
      hasFiniteVerb: (sentenceIndex: number): boolean =>
        finiteVerbBySentence[sentenceIndex] ?? false,
      junkScore: (sentenceIndex: number): number => junkScoreBySentence[sentenceIndex] ?? 0,
    };
    this.cache.set(text, analysis);
    return analysis;
  }

  /**
   * Lemma bag-of-words cosine similarity between two texts, in `[0, 1]`.
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Cosine similarity; `0` when either side has no informative lemmas.
   */
  public similarity(textA: string, textB: string): number {
    return cosineSimilarity(this.bagOfLemmas(textA), this.bagOfLemmas(textB));
  }

  /**
   * Lemma-bag containment coefficient between two texts, in `[0, 1]` (shared
   * lemma mass ÷ smaller bag's mass).
   *
   * @param textA - First text.
   * @param textB - Second text.
   * @returns Containment coefficient; `0` when either side has no lemmas.
   */
  public containment(textA: string, textB: string): number {
    return bagContainment(this.bagOfLemmas(textA), this.bagOfLemmas(textB));
  }

  /** Builds a lemma frequency vector (bag of words) from a text's analysis. */
  private bagOfLemmas(text: string): Map<string, number> {
    const bow = new Map<string, number>();
    for (const sentence of this.analyze(text).sentences) {
      for (const lemma of sentence.lemmas) {
        bow.set(lemma, (bow.get(lemma) ?? 0) + 1);
      }
    }
    return bow;
  }
}

/**
 * Combines the per-sentence word-token counts into the `[0, 1]` junk score
 * (weights and rationale on the JUNK_* constants above).
 */
function junkScoreFor(
  wordCount: number,
  capitalizedNonInitial: number,
  stopwordCount: number,
  longWordCount: number,
): number {
  if (wordCount === 0) {
    return 0;
  }
  const capRatio = wordCount > 1 ? capitalizedNonInitial / (wordCount - 1) : 0;
  const stopDeficit = Math.max(0, 1 - stopwordCount / wordCount / JUNK_STOPWORD_FLOOR);
  const longRatio = longWordCount / wordCount;
  return Math.min(
    1,
    JUNK_CAP_WEIGHT * capRatio + JUNK_STOP_WEIGHT * stopDeficit + JUNK_LONG_WEIGHT * longRatio,
  );
}
