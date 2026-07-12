/**
 * Query-driven, entity-anchored facet planner (absorbs the old `facets.ts`).
 *
 * The old comparison builder scraped the *first* currency or percentage it
 * found in each source's whole text — which is how a `$94,900` from an
 * unrelated paragraph, or a nursing-home price, ended up in an EV brief's
 * comparison table. This planner fixes both failure modes:
 *
 * - **Query-driven columns.** Only the columns the {@link QueryProfile}
 *   declares buildable are considered (a price column for price/comparison
 *   intents, a change column for rate/trend intents, nothing for
 *   general/factual intents). A query with no facet plan yields `null`.
 * - **Entity-anchored values.** A value counts only when it is *anchored*: the
 *   sentence carrying it also names a query target entity or a must-match term.
 *   A stray figure in an off-subject sentence is ignored.
 *
 * One value per source (cluster), chosen deterministically: the first anchored
 * occurrence in the cluster representative, with members filling gaps. A column
 * needs at least two sourced values, and the table needs at least two rows, or
 * the result is `null`. Pure and deterministic.
 */

import type { BriefSource } from '@yantra/protocol';

import type { EntityKind, TextAnalyzer } from '../analysis/text-analyzer.js';
import type { SourceCluster, SynthesisDoc } from '../types.js';

import type { AcceptedFacets, EvidenceKind, FacetPlan, QueryProfile } from './types.js';

interface AnchoredValue {
  readonly value: string;
  readonly sentence: string;
  readonly lemmas: readonly string[];
}

/** Maps a facet plan's evidence kind onto the analyzer entity kind to scan for. */
const ENTITY_KIND_BY_EVIDENCE: Partial<Record<EvidenceKind, EntityKind>> = {
  money: 'money',
  percent: 'percent',
  quantity: 'cardinal',
};

/** Minimum sourced values for a column to be included. */
const MIN_SOURCED_VALUES = 2;

/** Minimum rows for a comparison table to be emitted. */
const MIN_ROWS = 2;

/**
 * Builds the anchored comparison table for the profiled query, or `null`.
 *
 * @param docs - Relevance-passing documents (indexes match `clusters` members).
 * @param clusters - Near-duplicate source clusters, rank-ordered.
 * @param sources - The numbered Brief sources aligned with `clusters`.
 * @param profile - The query profile carrying the buildable `facetPlan`.
 * @param analyzer - Linguistic analyzer for entity typing and anchoring.
 * @returns The accepted facet table, or `null` when nothing is tabular.
 */
export function buildFacetTable(
  docs: readonly SynthesisDoc[],
  clusters: readonly SourceCluster[],
  sources: readonly BriefSource[],
  profile: QueryProfile,
  analyzer: TextAnalyzer,
): AcceptedFacets | null {
  if (profile.facetPlan.length === 0 || clusters.length < MIN_ROWS) {
    return null;
  }

  const anchorTerms = new Set<string>([...profile.targetEntities, ...profile.mustMatchTerms]);
  if (anchorTerms.size === 0) {
    return null;
  }

  const percentPlan = profile.facetPlan.find((plan) => plan.entityKind === 'percent');
  if (percentPlan !== undefined) {
    return buildPercentMetricTable(docs, clusters, sources, percentPlan, anchorTerms, analyzer);
  }

  // For each buildable non-percent column, the anchored value per source (cluster).
  const columns = profile.facetPlan
    .filter((plan) => plan.entityKind !== 'percent')
    .map((plan) => ({
      plan,
      values: clusters.map((cluster) =>
        pickAnchoredValue(cluster.members, plan, anchorTerms, docs, analyzer),
      ),
    }))
    .filter(({ values }) => values.filter((value) => value !== null).length >= MIN_SOURCED_VALUES);

  if (columns.length === 0) {
    return null;
  }

  const rows = sources.flatMap((source, sourceIndex) => {
    const cells = columns.map(({ values }) => values[sourceIndex]?.value ?? null);
    if (cells.every((cell) => cell === null)) {
      return [];
    }
    return [[source.host, ...cells]];
  });

  if (rows.length < MIN_ROWS) {
    return null;
  }

  return {
    columns: ['Source', ...columns.map(({ plan }) => plan.column)],
    rows,
  };
}

function buildPercentMetricTable(
  docs: readonly SynthesisDoc[],
  clusters: readonly SourceCluster[],
  sources: readonly BriefSource[],
  plan: FacetPlan,
  anchorTerms: ReadonlySet<string>,
  analyzer: TextAnalyzer,
): AcceptedFacets | null {
  const values = clusters.map((cluster) =>
    pickAnchoredValue(cluster.members, plan, anchorTerms, docs, analyzer),
  );

  const rows = sources.flatMap((source, sourceIndex) => {
    const value = values[sourceIndex];
    if (value === undefined || value === null) {
      return [];
    }
    const metric = deriveMetricLabel(value.sentence, value.lemmas);
    if (metric === null) {
      return [];
    }
    return [[source.host, metric, value.value]];
  });

  return rows.length >= MIN_ROWS ? { columns: ['Source', 'Metric', plan.column], rows } : null;
}

/**
 * Picks the first anchored value of the plan's entity kind across a cluster's
 * members (representative first). Returns the entity's display text, or null.
 */
function pickAnchoredValue(
  members: readonly number[],
  plan: FacetPlan,
  anchorTerms: ReadonlySet<string>,
  docs: readonly SynthesisDoc[],
  analyzer: TextAnalyzer,
): AnchoredValue | null {
  const entityKind = ENTITY_KIND_BY_EVIDENCE[plan.entityKind];
  if (entityKind === undefined) {
    return null;
  }

  for (const docIndex of members) {
    const doc = docs[docIndex];
    if (doc === undefined) {
      continue;
    }
    const analysis = analyzer.analyze(doc.text);
    for (const entity of analysis.entities) {
      if (entity.kind !== entityKind) {
        continue;
      }
      if (isAnchored(entity.sentenceIndex, anchorTerms, analysis)) {
        const sentence = analysis.sentences[entity.sentenceIndex];
        if (sentence === undefined) {
          continue;
        }
        return { value: entity.text, sentence: sentence.text, lemmas: sentence.lemmas };
      }
    }
  }
  return null;
}

/**
 * Derives a human label for a percentage row from its anchoring sentence.
 *
 * @param sentence - Sentence carrying the percentage.
 * @param lemmas - Analyzer lemmas for the same sentence.
 * @returns A label such as "Sales decline (YoY)", or null when unlabelable.
 */
export function deriveMetricLabel(sentence: string, lemmas: readonly string[]): string | null {
  const lemmaSet = new Set(lemmas);
  const lower = sentence.toLowerCase();
  const subject = metricSubject(lemmaSet, lower);
  if (subject === null) {
    return null;
  }
  if (subject === 'Market share') {
    return subject;
  }
  const direction = metricDirection(lemmaSet, lower);
  if (direction === null) {
    return null;
  }
  const basis = metricBasis(lower);
  return basis === null ? `${subject} ${direction}` : `${subject} ${direction} (${basis})`;
}

function metricSubject(lemmas: ReadonlySet<string>, lower: string): string | null {
  if (lemmas.has('share') || lower.includes('market share')) return 'Market share';
  if (lemmas.has('sale') || lower.includes('sales')) return 'Sales';
  if (lemmas.has('registration') || lower.includes('registrations')) return 'Registrations';
  if (lemmas.has('delivery') || lower.includes('deliveries')) return 'Deliveries';
  if (lemmas.has('price') || lower.includes('prices')) return 'Price';
  if (lemmas.has('revenue')) return 'Revenue';
  if (lemmas.has('growth')) return 'Growth';
  if (lemmas.has('demand')) return 'Demand';
  if (lemmas.has('production')) return 'Production';
  if (lemmas.has('inventory')) return 'Inventory';
  return null;
}

function metricDirection(lemmas: ReadonlySet<string>, lower: string): string | null {
  if (
    ['fall', 'drop', 'decline', 'plunge', 'crater', 'fell', 'down'].some(
      (word) => lemmas.has(word) || lower.includes(word),
    )
  ) {
    return 'decline';
  }
  if (
    ['rise', 'grow', 'increase', 'climb', 'jump', 'rose', 'up'].some(
      (word) => lemmas.has(word) || lower.includes(word),
    )
  ) {
    return 'rise';
  }
  return null;
}

function metricBasis(lower: string): string | null {
  if (/\byoy\b|year[-\s]?over[-\s]?year|from a year earlier|versus last year/u.test(lower)) {
    return 'YoY';
  }
  if (/\bmom\b|month[-\s]?over[-\s]?month|from the prior month/u.test(lower)) {
    return 'MoM';
  }
  if (/\bqoq\b|quarter[-\s]?over[-\s]?quarter|from the prior quarter/u.test(lower)) {
    return 'QoQ';
  }
  return null;
}

/** True when a sentence names a query anchor term (target entity / must-match). */
function isAnchored(
  sentenceIndex: number,
  anchorTerms: ReadonlySet<string>,
  analysis: ReturnType<TextAnalyzer['analyze']>,
): boolean {
  const sentence = analysis.sentences[sentenceIndex];
  if (sentence === undefined) {
    return false;
  }
  const keys = new Set<string>(sentence.lemmas);
  for (const entity of analysis.entities) {
    if (entity.sentenceIndex === sentenceIndex && entity.kind === 'named') {
      keys.add(entity.normalized);
    }
  }
  for (const term of anchorTerms) {
    if (keys.has(term)) {
      return true;
    }
  }
  return false;
}
