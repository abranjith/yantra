/**
 * Deterministic query profiler.
 *
 * Turns the user's raw query into a {@link QueryProfile} that every downstream
 * gate consults: the inferred {@link QueryIntent} decides which evidence kinds
 * a numeric claim must carry and which comparison columns are buildable, while
 * the target entities and must-match terms drive the relevance floor. Pure and
 * deterministic — same query + analyzer ⇒ same profile.
 *
 * ## Intent → evidence-kind / facet mapping
 *
 * | Intent           | requiredEvidenceKinds   | facet column      |
 * | ---------------- | ----------------------- | ----------------- |
 * | `price_lookup`   | `money`                 | Price (money)     |
 * | `comparison`     | `money`                 | Price (money)     |
 * | `rate_or_trend`  | `percent`, `quantity`   | Change (percent)  |
 * | `factual_lookup` | —                       | —                 |
 * | `entity_profile` | —                       | —                 |
 * | `general`        | —                       | —                 |
 *
 * Intents with no required kinds admit a numeric claim only when its sentence
 * also carries a target entity (the relevance contract in TASK-005).
 */

import type { TextAnalyzer } from '../analysis/text-analyzer.js';

import type {
  EvidenceKind,
  FacetPlan,
  QueryIntent,
  QueryProfile,
  TimeSensitivity,
} from './types.js';

/** Price-intent signal lemmas/terms. */
const PRICE_TERMS: ReadonlySet<string> = new Set([
  'price',
  'cost',
  'cheap',
  'cheapest',
  'deal',
  'buy',
  'afford',
  'affordable',
  'discount',
  'expensive',
  'pricing',
  'msrp',
]);

/** Comparison-intent signal lemmas/terms. */
const COMPARISON_TERMS: ReadonlySet<string> = new Set([
  'vs',
  'versus',
  'compare',
  'comparison',
  'difference',
  'best',
  'top',
  'worst',
  'alternative',
  'alternatives',
]);

/** Rate/trend-intent signal lemmas/terms. */
const TREND_TERMS: ReadonlySet<string> = new Set([
  'rate',
  'share',
  'growth',
  'grow',
  'trend',
  'sale',
  'sell',
  'decline',
  'increase',
  'decrease',
  'adoption',
  'forecast',
  'statistic',
  'statistics',
  'percentage',
  'percent',
  'market',
  'demand',
  'projection',
  'outlook',
  'revenue',
]);

/** Interrogatives that mark a factual-lookup question. */
const WH_WORDS: ReadonlySet<string> = new Set([
  'what',
  'when',
  'where',
  'who',
  'whom',
  'whose',
  'why',
  'which',
  'how',
]);

/** Present-moment time markers. */
const CURRENT_MARKERS: ReadonlySet<string> = new Set([
  'today',
  'now',
  'current',
  'currently',
  'latest',
  'live',
]);

/** Recent-window time markers (beyond a specific year). */
const RECENT_MARKERS: ReadonlySet<string> = new Set([
  'recent',
  'recently',
  'newest',
  'ytd',
  'upcoming',
]);

/** Required evidence kinds per intent. */
const REQUIRED_KINDS: Readonly<Record<QueryIntent, readonly EvidenceKind[]>> = {
  price_lookup: ['money'],
  comparison: ['money'],
  rate_or_trend: ['percent', 'quantity'],
  factual_lookup: [],
  entity_profile: [],
  general: [],
};

/** Buildable facet columns per intent. */
const FACET_PLANS: Readonly<Record<QueryIntent, readonly FacetPlan[]>> = {
  price_lookup: [{ column: 'Price', entityKind: 'money' }],
  comparison: [{ column: 'Price', entityKind: 'money' }],
  rate_or_trend: [{ column: 'Change', entityKind: 'percent' }],
  factual_lookup: [],
  entity_profile: [],
  general: [],
};

/** True when any of `signals` appears in the query's term set. */
function hasSignal(terms: ReadonlySet<string>, signals: ReadonlySet<string>): boolean {
  for (const signal of signals) {
    if (terms.has(signal)) {
      return true;
    }
  }
  return false;
}

/** True when the string looks like a 4-digit calendar year. */
function isYear(term: string): boolean {
  return /^(?:19|20)\d{2}$/u.test(term);
}

/** Removes duplicates while preserving first-seen order. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Builds the deterministic {@link QueryProfile} for a query.
 *
 * @param query - The user's raw question or topic.
 * @param analyzer - Linguistic analyzer used to lemmatize and type the query.
 * @returns The query profile driving every relevance/eligibility gate.
 */
export function buildQueryProfile(query: string, analyzer: TextAnalyzer): QueryProfile {
  const analysis = analyzer.analyze(query);
  const lower = query.toLowerCase();

  const lemmas = analysis.sentences.flatMap((sentence) => sentence.lemmas);
  const normals = analysis.sentences.flatMap((sentence) => sentence.tokens);
  // Match signals against both the surface form and the lemma so "prices"
  // (→ "price") and "best" (→ "good") are both detectable.
  const terms = new Set<string>([...normals, ...lemmas]);

  const targetEntities = unique(
    analysis.entities
      .filter((entity) => entity.kind === 'named')
      .map((entity) => entity.normalized),
  );
  const mustMatchTerms = unique(lemmas);

  const firstToken = /^[\s"']*([\p{L}]+)/u.exec(lower)?.[1] ?? '';
  const isQuestion = WH_WORDS.has(firstToken) || lower.includes('?');
  const hasFiniteVerb = analysis.sentences.some((_, index) => analysis.hasFiniteVerb(index));

  const intent = classifyIntent({
    terms,
    lower,
    isQuestion,
    hasFiniteVerb,
    hasTargetEntity: targetEntities.length > 0,
  });

  return {
    intent,
    targetEntities,
    mustMatchTerms,
    requiredEvidenceKinds: REQUIRED_KINDS[intent],
    facetPlan: FACET_PLANS[intent],
    timeSensitivity: classifyTimeSensitivity(terms),
  };
}

interface IntentSignals {
  readonly terms: ReadonlySet<string>;
  readonly lower: string;
  readonly isQuestion: boolean;
  readonly hasFiniteVerb: boolean;
  readonly hasTargetEntity: boolean;
}

/** Classifies intent by keyword/phrase precedence (comparison → … → general). */
function classifyIntent(signals: IntentSignals): QueryIntent {
  const { terms, lower } = signals;

  if (hasSignal(terms, COMPARISON_TERMS) || /\bvs\b|difference between|compared to/u.test(lower)) {
    return 'comparison';
  }
  if (hasSignal(terms, PRICE_TERMS) || lower.includes('how much')) {
    return 'price_lookup';
  }
  if (hasSignal(terms, TREND_TERMS) || /market share|state of|how many|growth rate/u.test(lower)) {
    return 'rate_or_trend';
  }
  if (signals.isQuestion) {
    return 'factual_lookup';
  }
  if (!signals.hasFiniteVerb && signals.hasTargetEntity) {
    return 'entity_profile';
  }
  return 'general';
}

/** Classifies how time-bound the query is from its markers. */
function classifyTimeSensitivity(terms: ReadonlySet<string>): TimeSensitivity {
  if (hasSignal(terms, CURRENT_MARKERS)) {
    return 'current';
  }
  if (hasSignal(terms, RECENT_MARKERS)) {
    return 'recent';
  }
  for (const term of terms) {
    if (isYear(term)) {
      return 'recent';
    }
  }
  return 'timeless';
}
