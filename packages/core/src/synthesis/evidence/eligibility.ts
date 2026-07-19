/**
 * Claim eligibility + sentence-level support + ranking (absorbs the old
 * `claims.ts`).
 *
 * This is where "evidence selection first" is enforced. Candidate sentences
 * from the relevance-passing documents must clear the **hard gates** before
 * they can become findings:
 *
 * 0. **Boilerplate** — source-chrome and marketing openers ("Last updated…",
 *    "Check out…", "Welcome to…") are rejected outright.
 * 0.5. **Junk shape** ({@link isJunkSentence}) — glued UI fragments
 *    ("HEADLINESNext", ≥ 3 lowercase→uppercase boundaries), ALL-CAPS chrome
 *    runs ("MUST READS"), video-player timestamps and pipe separators
 *    ("01:18:30 | …"), sentences that do not start with a capital/digit or
 *    end with terminal punctuation ("† denotes…", bare fragments), unbalanced
 *    parens/quotes, and editorial questions ("…turn on the style?").
 * 1. **Grammaticality** — the sentence carries a finite verb
 *    ({@link DocAnalysis.hasFiniteVerb}). Headings and nav fragments
 *    ("State-Wise EV Sales & Adoption") are rejected outright.
 * 2. **Size** — the sentence is within readable claim bounds and has enough
 *    informative tokens.
 * 3. **Evidence-kind match** — a sentence carrying a typed *figure* is kept
 *    only when that figure's kind is one the query wants
 *    ({@link QueryProfile.requiredEvidenceKinds}) *or* the sentence also names
 *    a target entity. A stray "125 Interesting Facts" number for an EV query
 *    fails here.
 * 4. **Relevance floor** — the sentence must name a target entity or clear a
 *    must-match coverage threshold. This is a hard filter, replacing the old
 *    query-overlap *dampener* (which only scaled salience and let off-topic
 *    sentences through).
 *
 * **Support is sentence-level.** The old code counted a whole document as
 * evidence when it shared 60% of a claim's tokens anywhere in its text — the
 * direct cause of `[1][4][6][7][8][9][10]` citation runs. A document now
 * supports a claim only when *one of its sentences* restates it: it carries the
 * claim's numeric figures, or clears a lemma-overlap threshold within a single
 * sentence.
 *
 * Ranking reuses the existing salience formula, computed over the gated set,
 * with the same deterministic tie-breaks. Pure and deterministic throughout.
 */

import type {
  AnalyzedSentence,
  DocAnalysis,
  EntityKind,
  TextAnalyzer,
} from '../analysis/text-analyzer.js';
import type { ClaimKind, SynthesisDoc } from '../types.js';

import type { EvidenceClaim, EvidenceKind, QueryProfile } from './types.js';

/** Sentence-position decay factor used in the salience position weight. */
const POSITION_DECAY = 0.15;

/** Minimum informative tokens for a sentence to be a claim candidate. */
const MIN_CLAIM_TOKENS = 5;

/** Bounds keeping claims readable as findings. */
const MIN_CLAIM_CHARS = 25;
const MAX_CLAIM_CHARS = 400;

/** Cap on ranked claims returned; downstream budgets are far smaller. */
const MAX_CLAIMS = 50;

/** Lemma-overlap threshold for one sentence to count as restating a claim. */
const SUPPORT_LEMMA_OVERLAP = 0.6;

/**
 * Absolute sentence-sentiment above which (exclusive) a `fact`/`number` claim
 * is treated as *opinion* and demoted out of the `Key facts` pool (it stays
 * eligible for key findings and `Additional findings` — demote, never drop).
 *
 * Calibration (FEAT-WI-003 spike): winkNLP's lexicon scores clear opinion high
 * ("This is a fantastic, must-buy EV" ≈ 0.7) and plain figures low ("Sales
 * rose 12% in 2025" ≈ 0.2), but also fires on domain-neutral words — "Norway
 * are one win from the semi-final" scores 0.8 via "win". `0.6` keeps
 * mildly-positive factual prose (≤ 0.5) in `Key facts` while catching marketing
 * language; sentiment is a gate signal only and is never rendered.
 */
export const SENTIMENT_OPINION_THRESHOLD = 0.6;

/**
 * True when a claim is too opinionated for the `Key facts` section: it is a
 * `fact`/`number` claim whose source-sentence |sentiment| exceeds
 * {@link SENTIMENT_OPINION_THRESHOLD}. Entity/quote claims are never demoted —
 * they do not feed `Key facts` in the first place.
 *
 * @param claim - An accepted evidence claim.
 * @returns True when the claim must stay out of the `Key facts` pool.
 */
export function isOpinionClaim(claim: Pick<EvidenceClaim, 'kind' | 'sentiment'>): boolean {
  return (
    (claim.kind === 'fact' || claim.kind === 'number') &&
    Math.abs(claim.sentiment) > SENTIMENT_OPINION_THRESHOLD
  );
}

/** Numeric evidence kinds subject to the evidence-kind gate. */
const NUMERIC_KINDS: ReadonlySet<EvidenceKind> = new Set(['money', 'percent', 'quantity', 'date']);

/** Percent/money only: safe anchors for numeric duplicate merging. */
const ANCHOR_VALUE_KINDS: ReadonlySet<EntityKind> = new Set(['money', 'percent']);

/** Boilerplate/source-chrome openers rejected before content gates. */
const BOILERPLATE_PATTERN =
  /^(last updated|updated on|updated:|published(?: on|:)|posted(?: on|:)|by [A-Z][a-z]+ [A-Z]|read more|subscribe|sign up|advertisement|sponsored|share this|follow us|related (?:articles?|posts?)|table of contents|skip to|photo(?: credit)?:|image:|source:|check out|welcome to|discover|don't miss|watch|learn more|find out|see all|read next|up next|more from|trending|newsletter|download the app|breaking:)\b/iu;

/** Caps run flowing into a word ("HEADLINESNext", "FCWhy"). */
const CAPS_GLUE_PATTERN = /[A-Z]{2,}[a-z]{2,}/u;

/** Lowercase-to-uppercase boundary; ≥ 3 of these means glued fragments. */
const LOWER_UPPER_BOUNDARY = /[a-z][A-Z]/gu;

/** Three or more consecutive ALL-CAPS words (chrome candidates). */
const ALL_CAPS_RUN_PATTERN = /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}\b/u;

/** Common two-word source-chrome labels that are not ordinary acronym pairs. */
const ALL_CAPS_CHROME_LABEL_PATTERN = /\b(?:MUST READS?|BREAKING NEWS|TOP STORIES)\b/u;

/** Clock/video timestamp ("01:18:30", "9:41"). */
const TIMESTAMP_PATTERN = /\b\d{1,2}:\d{2}(?::\d{2})?\b/u;

/** A claim sentence must open with a capital, digit, or opening quote/paren. */
const WELL_FORMED_START = /^["'“‘(]?[A-Z0-9]/u;

/** A claim sentence must close with terminal punctuation. */
const TERMINAL_PUNCTUATION = /[.!?…]["'”’)\]]?$/u;

/** Interrogative ending — editorial questions are not findings. */
const INTERROGATIVE_END = /\?["'”’)\]]?$/u;

const FIRST_WORD_ANAPHORS: ReadonlySet<string> = new Set(['it', 'they', 'he', 'she']);
const DEICTIC_ANAPHORS: ReadonlySet<string> = new Set(['this', 'these', 'that', 'those']);
const CONNECTIVE_ANAPHORS: ReadonlySet<string> = new Set([
  'however',
  'but',
  'meanwhile',
  'still',
  'additionally',
  'also',
  'moreover',
  'furthermore',
  'yet',
  'instead',
  'nevertheless',
  'nonetheless',
]);
const TEMPORAL_DEIXIS: ReadonlySet<string> = new Set([
  'year',
  'month',
  'week',
  'quarter',
  'decade',
  'time',
]);

/** Maps analyzer entity kinds onto the pipeline's evidence-kind vocabulary. */
const EVIDENCE_KIND_BY_ENTITY: Readonly<Record<EntityKind, EvidenceKind>> = {
  money: 'money',
  percent: 'percent',
  date: 'date',
  cardinal: 'quantity',
  named: 'entity',
};

/** Priority used when the same sentence surfaces from several docs. */
const KIND_PRIORITY: Readonly<Record<ClaimKind, number>> = {
  number: 3,
  entity: 2,
  quote: 1,
  fact: 0,
};

/** Per-sentence analysis prepared once for gating, support, and ranking. */
interface PreparedSentence {
  readonly index: number;
  readonly text: string;
  readonly lemmas: ReadonlySet<string>;
  readonly numericValues: ReadonlySet<string>;
  readonly anchorValues: ReadonlySet<string>;
  readonly entityKeys: ReadonlySet<string>;
  /** Word-level named-entity keys (see EvidenceClaim.entityKeys). */
  readonly namedKeys: ReadonlySet<string>;
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly kind: ClaimKind;
  readonly hasFiniteVerb: boolean;
  readonly anaphoric: boolean;
  /** Sentence-level negation flag (analyzer `AnalyzedSentence.negated`). */
  readonly negated: boolean;
  /** Sentence sentiment in [-1, 1] (analyzer `AnalyzedSentence.sentiment`). */
  readonly sentiment: number;
}

/** A relevance-passing document's prepared sentences. */
interface PreparedDoc {
  readonly docIndex: number;
  readonly sentences: readonly PreparedSentence[];
}

/**
 * Extracts eligible, sentence-supported, ranked claims from the
 * relevance-passing document set.
 *
 * @param docs - Relevance-passing documents (array order = search rank).
 * @param profile - The query profile driving the eligibility gates.
 * @param analyzer - Linguistic analyzer (sentences, entities, POS).
 * @returns Ranked {@link EvidenceClaim}s (highest salience first), each with
 *   sentence-level `docIndexes` (indexes into `docs`).
 */
export function extractEligibleClaims(
  docs: readonly SynthesisDoc[],
  profile: QueryProfile,
  analyzer: TextAnalyzer,
): readonly EvidenceClaim[] {
  if (docs.length === 0) {
    return [];
  }

  const prepared = docs.map((doc, docIndex) => prepareDoc(doc, docIndex, analyzer));

  // Candidate sentences that clear all hard gates, deduplicated across
  // docs by normalized text (best-ranked origin wins; support re-adds the rest).
  const byNormalized = new Map<string, { doc: PreparedDoc; sentence: PreparedSentence }>();
  for (const doc of prepared) {
    for (const sentence of eligibleSentencesForDoc(doc, profile)) {
      const key = normalizeClaimText(sentence.text);
      const existing = byNormalized.get(key);
      if (
        existing === undefined ||
        KIND_PRIORITY[sentence.kind] > KIND_PRIORITY[existing.sentence.kind] ||
        (KIND_PRIORITY[sentence.kind] === KIND_PRIORITY[existing.sentence.kind] &&
          doc.docIndex < existing.doc.docIndex)
      ) {
        byNormalized.set(key, { doc, sentence });
      }
    }
  }

  const claims: EvidenceClaim[] = [];
  for (const { doc, sentence } of byNormalized.values()) {
    const docIndexes = supportingDocs(sentence, doc.docIndex, prepared);
    const overlap = coverage(sentence.lemmas, profile.mustMatchTerms);
    const positionWeight = 1 / (1 + sentence.index * POSITION_DECAY);
    const salience = docIndexes.length * positionWeight * (1 + overlap);

    claims.push({
      text: sentence.text,
      kind: sentence.kind,
      evidenceKinds: sentence.evidenceKinds,
      anchorValues: [...sentence.anchorValues],
      entityKeys: [...sentence.namedKeys].sort(),
      docIndexes,
      salience,
      negated: sentence.negated,
      sentiment: sentence.sentiment,
    });
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

/** Counts claim candidates before gating — feeds `metadata.evidence`. */
export function countCandidateSentences(
  docs: readonly SynthesisDoc[],
  analyzer: TextAnalyzer,
): number {
  let total = 0;
  for (const doc of docs) {
    for (const sentence of analyzer.analyze(doc.text).sentences) {
      if (isClaimSized(sentence.text) && sentence.tokens.length >= MIN_CLAIM_TOKENS) {
        total += 1;
      }
    }
  }
  return total;
}

/** Prepares one document's sentences for gating, support, and ranking. */
function prepareDoc(doc: SynthesisDoc, docIndex: number, analyzer: TextAnalyzer): PreparedDoc {
  const analysis = analyzer.analyze(doc.text);
  const sentences = analysis.sentences.map((sentence) => prepareSentence(sentence, analysis));
  return { docIndex, sentences };
}

/** Builds the per-sentence view (entity kinds, numeric values, entity keys). */
function prepareSentence(analyzed: AnalyzedSentence, analysis: DocAnalysis): PreparedSentence {
  const { index, text, lemmas } = analyzed;
  const entities = analysis.entities.filter((entity) => entity.sentenceIndex === index);
  const evidenceKindSet = new Set<EvidenceKind>();
  const numericValues = new Set<string>();
  const anchorValues = new Set<string>();
  const entityKeys = new Set<string>(lemmas);
  const namedKeys = new Set<string>();
  const displayText = collapseWhitespace(text);

  for (const entity of entities) {
    const kind = EVIDENCE_KIND_BY_ENTITY[entity.kind];
    evidenceKindSet.add(kind);
    if (NUMERIC_KINDS.has(kind)) {
      numericValues.add(entity.normalized);
    }
    if (ANCHOR_VALUE_KINDS.has(entity.kind)) {
      anchorValues.add(entity.normalized);
    }
    if (entity.kind === 'named') {
      entityKeys.add(entity.normalized);
      for (const word of entity.normalized.split(/\s+/u)) {
        if (word.length > 1) {
          namedKeys.add(word);
        }
      }
    }
  }

  const hasNumeric = [...evidenceKindSet].some((kind) => NUMERIC_KINDS.has(kind));
  const kind: ClaimKind = hasNumeric ? 'number' : evidenceKindSet.has('entity') ? 'entity' : 'fact';

  const evidenceKinds = evidenceKindSet.size > 0 ? [...evidenceKindSet] : (['statement'] as const);

  return {
    index,
    text: displayText,
    lemmas: new Set(lemmas),
    numericValues,
    anchorValues,
    entityKeys,
    namedKeys,
    evidenceKinds,
    kind,
    hasFiniteVerb: analysis.hasFiniteVerb(index),
    anaphoric: isAnaphoric(displayText),
    negated: analyzed.negated,
    sentiment: analyzed.sentiment,
  };
}

function eligibleSentencesForDoc(
  doc: PreparedDoc,
  profile: QueryProfile,
): readonly PreparedSentence[] {
  const accepted: PreparedSentence[] = [];
  const consumed = new Set<number>();

  for (const sentence of doc.sentences) {
    if (sentence.anaphoric) {
      const stitched = stitchAnaphor(sentence, doc, profile, consumed);
      if (stitched !== null) {
        consumed.add(stitched.index);
        const previous = accepted.findIndex((entry) => entry.index === stitched.index);
        if (previous !== -1) {
          accepted.splice(previous, 1);
        }
        accepted.push(stitched);
      }
      continue;
    }

    if (passesGates(sentence, profile) && !consumed.has(sentence.index)) {
      accepted.push(sentence);
    }
  }

  return accepted;
}

function stitchAnaphor(
  sentence: PreparedSentence,
  doc: PreparedDoc,
  profile: QueryProfile,
  consumed: ReadonlySet<number>,
): PreparedSentence | null {
  const antecedent = doc.sentences[sentence.index - 1];
  if (
    antecedent === undefined ||
    antecedent.anaphoric ||
    consumed.has(antecedent.index) ||
    !passesGates(antecedent, profile)
  ) {
    return null;
  }

  const text = collapseWhitespace(`${antecedent.text} ${sentence.text}`);
  if (text.length > MAX_CLAIM_CHARS) {
    return null;
  }

  const evidenceKinds = unionArray(antecedent.evidenceKinds, sentence.evidenceKinds);
  const hasNumeric = evidenceKinds.some((kind) => NUMERIC_KINDS.has(kind));
  const kind: ClaimKind = hasNumeric
    ? 'number'
    : evidenceKinds.includes('entity')
      ? 'entity'
      : 'fact';

  return {
    index: antecedent.index,
    text,
    lemmas: unionSet(antecedent.lemmas, sentence.lemmas),
    numericValues: unionSet(antecedent.numericValues, sentence.numericValues),
    anchorValues: unionSet(antecedent.anchorValues, sentence.anchorValues),
    entityKeys: unionSet(antecedent.entityKeys, sentence.entityKeys),
    namedKeys: unionSet(antecedent.namedKeys, sentence.namedKeys),
    evidenceKinds,
    kind,
    hasFiniteVerb: true,
    anaphoric: false,
    // The stitched claim is negated if either half is; its sentiment is the
    // stronger (larger-magnitude) of the two, antecedent winning ties.
    negated: antecedent.negated || sentence.negated,
    sentiment:
      Math.abs(sentence.sentiment) > Math.abs(antecedent.sentiment)
        ? sentence.sentiment
        : antecedent.sentiment,
  };
}

/**
 * Gate 0.5: UI-chrome / malformed-sentence rejection (see the module header's
 * gate list). Each sub-check is a named predicate so the table-driven junk
 * corpus can pin its behavior. Exported for tests.
 *
 * @param text - The candidate sentence's display text.
 * @returns True when the sentence is junk and must not become a claim.
 */
export function isJunkSentence(text: string): boolean {
  return (
    hasIntrawordGlue(text) ||
    hasAllCapsChrome(text) ||
    hasPlayerChrome(text) ||
    isMalformedShape(text) ||
    INTERROGATIVE_END.test(text)
  );
}

/** Glued fragments: caps-run flowing into a word, or ≥ 3 aZ boundaries. */
function hasIntrawordGlue(text: string): boolean {
  if (CAPS_GLUE_PATTERN.test(text)) {
    return true;
  }
  return (text.match(LOWER_UPPER_BOUNDARY) ?? []).length >= 3;
}

/**
 * ALL-CAPS chrome: a known two-word label or a run of at least three words.
 * Two-word acronym pairs such as "US EV" are legitimate prose and must pass.
 */
function hasAllCapsChrome(text: string): boolean {
  return ALL_CAPS_CHROME_LABEL_PATTERN.test(text) || ALL_CAPS_RUN_PATTERN.test(text);
}

/** Video-player/nav chrome: leading timestamp or a spaced pipe separator. */
function hasPlayerChrome(text: string): boolean {
  const timestamp = TIMESTAMP_PATTERN.exec(text);
  if (timestamp !== null && (timestamp.index ?? 0) < 20) {
    return true;
  }
  return /\s\|\s?|^\|/u.test(text);
}

/** Malformed shape: bad opener, no terminal punctuation, unbalanced pairs. */
function isMalformedShape(text: string): boolean {
  if (!WELL_FORMED_START.test(text) || !TERMINAL_PUNCTUATION.test(text)) {
    return true;
  }
  const opens = (text.match(/\(/gu) ?? []).length;
  const closes = (text.match(/\)/gu) ?? []).length;
  if (opens !== closes) {
    return true;
  }
  return (text.match(/"/gu) ?? []).length % 2 !== 0;
}

/** Applies the hard eligibility gates to one sentence. */
function passesGates(sentence: PreparedSentence, profile: QueryProfile): boolean {
  // Gate 0: source boilerplate.
  if (BOILERPLATE_PATTERN.test(sentence.text)) {
    return false;
  }
  // Gate 0.5: UI chrome and malformed sentence shapes.
  if (isJunkSentence(sentence.text)) {
    return false;
  }
  // Gate 1: grammaticality (kills headings and nav fragments).
  if (!sentence.hasFiniteVerb) {
    return false;
  }
  // Gate 2: size / token bounds.
  if (!isClaimSized(sentence.text) || sentence.lemmas.size < MIN_CLAIM_TOKENS) {
    return false;
  }

  const hasTargetEntity = profile.targetEntities.some((entity) => sentence.entityKeys.has(entity));

  // Gate 3: evidence-kind match — only for number-seeking intents (price /
  // comparison / rate-or-trend, which declare required kinds). There, a
  // figure-carrying sentence is on-topic only when its figure kind is wanted or
  // it also names a target entity, so a stray price in an EV-rate query is
  // dropped. Intents that want no particular figure (general / factual /
  // entity-profile) skip this gate and rely on the relevance floor below.
  if (profile.requiredEvidenceKinds.length > 0) {
    const numericKinds = sentence.evidenceKinds.filter((kind) => NUMERIC_KINDS.has(kind));
    if (numericKinds.length > 0) {
      const wanted = numericKinds.some((kind) => profile.requiredEvidenceKinds.includes(kind));
      if (!wanted && !hasTargetEntity) {
        return false;
      }
    }
  }

  // Gate 4: relevance floor. The source relevance gate has already established
  // that the document is on-topic, so within it a candidate sentence only needs
  // to touch the query: name a target entity, or share at least one must-match
  // term. A tangent that shares no query term (a Mars aside in an EV article) is
  // still dropped. Salience (below) rewards higher query overlap among those
  // that pass.
  if (
    profile.mustMatchTerms.length > 0 &&
    !hasTargetEntity &&
    !sharesTerm(sentence.lemmas, profile.mustMatchTerms)
  ) {
    return false;
  }

  return true;
}

/** True when any of `terms` appears in `lemmas`. */
function sharesTerm(lemmas: ReadonlySet<string>, terms: readonly string[]): boolean {
  return terms.some((term) => lemmas.has(term));
}

/**
 * Sentence-level support: the origin doc always counts, plus every other doc
 * that has a *single sentence* restating the claim — carrying its numeric
 * figures or clearing the lemma-overlap threshold.
 */
function supportingDocs(
  claim: PreparedSentence,
  originDocIndex: number,
  docs: readonly PreparedDoc[],
): number[] {
  const supporters: number[] = [];
  for (const doc of docs) {
    if (doc.docIndex === originDocIndex) {
      continue;
    }
    if (doc.sentences.some((sentence) => sentenceSupports(claim, sentence))) {
      supporters.push(doc.docIndex);
    }
  }
  return [originDocIndex, ...supporters].sort((left, right) => left - right);
}

/**
 * True when `sentence` restates `claim` (numeric figures or lemma overlap).
 *
 * Polarity-guarded: a sentence never supports a claim of opposite polarity —
 * "sales did not rise" has the same informative-lemma bag as "sales rose"
 * (negators are stopwords), so without the guard a contradicting doc would be
 * cited as supporting evidence.
 */
function sentenceSupports(claim: PreparedSentence, sentence: PreparedSentence): boolean {
  if (claim.negated !== sentence.negated) {
    return false;
  }
  if (claim.numericValues.size > 0 && isSubset(claim.numericValues, sentence.numericValues)) {
    return true;
  }
  return lemmaOverlap(claim.lemmas, sentence.lemmas) >= SUPPORT_LEMMA_OVERLAP;
}

/** Fraction of `terms` present in `lemmas` (0 when there are no terms). */
function coverage(lemmas: ReadonlySet<string>, terms: readonly string[]): number {
  if (terms.length === 0) {
    return 1;
  }
  let hits = 0;
  for (const term of terms) {
    if (lemmas.has(term)) {
      hits += 1;
    }
  }
  return hits / terms.length;
}

/** Fraction of `claimLemmas` also present in `otherLemmas`. */
function lemmaOverlap(claimLemmas: ReadonlySet<string>, otherLemmas: ReadonlySet<string>): number {
  if (claimLemmas.size === 0) {
    return 0;
  }
  let hits = 0;
  for (const lemma of claimLemmas) {
    if (otherLemmas.has(lemma)) {
      hits += 1;
    }
  }
  return hits / claimLemmas.size;
}

/** True when every member of `subset` is present in `superset`. */
function isSubset(subset: ReadonlySet<string>, superset: ReadonlySet<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) {
      return false;
    }
  }
  return true;
}

/** True when the sentence length is within readable claim bounds. */
function isClaimSized(sentence: string): boolean {
  return sentence.length >= MIN_CLAIM_CHARS && sentence.length <= MAX_CLAIM_CHARS;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Case/whitespace-normalized claim key for cross-doc deduplication. */
function normalizeClaimText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function isAnaphoric(text: string): boolean {
  const words = text
    .replace(/^[^\p{L}]+/u, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const first = words[0];
  if (first === undefined) {
    return false;
  }
  if (FIRST_WORD_ANAPHORS.has(first) || CONNECTIVE_ANAPHORS.has(first)) {
    return true;
  }
  if (DEICTIC_ANAPHORS.has(first)) {
    const second = words[1];
    return second === undefined || !TEMPORAL_DEIXIS.has(second);
  }
  return false;
}

function unionSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): ReadonlySet<T> {
  return new Set([...left, ...right]);
}

function unionArray<T>(left: readonly T[], right: readonly T[]): readonly T[] {
  return [...new Set([...left, ...right])];
}
