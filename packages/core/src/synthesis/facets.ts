/**
 * Comparison-facet builder for the synthesis stage.
 *
 * Detects a *comparative shape* in the source set — two or more sources
 * exposing the same numeric attribute (a price, a percentage) — and turns it
 * into the Brief's tabular `facets.comparison`. Queries without a
 * comparative shape yield `null`, never an empty table.
 */

import type { BriefFacets, BriefSource } from '@yantra/protocol';

import type { SourceCluster, SynthesisDoc } from './types.js';

/** First currency amount in a text ("$328", "€ 1.299,00", "£45.50"). */
const CURRENCY_PATTERN = /[$€£¥]\s?\d[\d,.]*/u;

/** First percentage in a text ("15%", "3.5 %"). */
const PERCENT_PATTERN = /\d+(?:[.,]\d+)?\s?%/u;

interface AttributeDetector {
  /** Column header for the attribute. */
  readonly name: string;
  /** Extracts the attribute value from a source's text, or null. */
  extract(text: string): string | null;
}

const DETECTORS: readonly AttributeDetector[] = [
  {
    name: 'Price',
    extract: (text) => CURRENCY_PATTERN.exec(text)?.[0]?.replace(/\s+/gu, '') ?? null,
  },
  {
    name: 'Percentage',
    extract: (text) => PERCENT_PATTERN.exec(text)?.[0]?.replace(/\s+/gu, '') ?? null,
  },
];

/**
 * Builds the comparison facet from the clustered source set.
 *
 * An attribute column is included only when at least two sources expose a
 * value for it; a source contributes a row only when it has a value for at
 * least one included column. When no attribute clears the two-source bar,
 * the result is `null` (the query has no comparative shape).
 *
 * @param docs - The extracted docs (evidence text per source).
 * @param clusters - Near-duplicate clusters, rank-ordered (see clustering.ts).
 * @param sources - The numbered Brief sources aligned with `clusters`.
 * @returns The comparison facets block, or null when nothing is tabular.
 */
export function buildComparisonFacet(
  docs: readonly SynthesisDoc[],
  clusters: readonly SourceCluster[],
  sources: readonly BriefSource[],
): BriefFacets | null {
  if (clusters.length < 2) {
    return null;
  }

  // One evidence text per source: the representative's text is primary and
  // syndicated members fill gaps (a mirror may keep a price the rep dropped).
  const textBySource = clusters.map((cluster) =>
    cluster.members.map((member) => docs[member]?.text ?? '').join('\n'),
  );

  const valuesByDetector = DETECTORS.map((detector) =>
    textBySource.map((text) => detector.extract(text)),
  );

  const includedDetectors = DETECTORS.map((detector, index) => ({
    detector,
    values: valuesByDetector[index]!,
  })).filter(({ values }) => values.filter((value) => value !== null).length >= 2);

  if (includedDetectors.length === 0) {
    return null;
  }

  const rows = sources.flatMap((source, sourceIndex) => {
    const cells = includedDetectors.map(({ values }) => values[sourceIndex] ?? null);
    if (cells.every((cell) => cell === null)) {
      return [];
    }
    return [[source.host, ...cells]];
  });

  if (rows.length < 2) {
    return null;
  }

  return {
    comparison: {
      columns: ['Source', ...includedDetectors.map(({ detector }) => detector.name)],
      rows,
    },
  };
}
