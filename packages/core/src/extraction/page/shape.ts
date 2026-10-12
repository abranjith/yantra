/**
 * Shape arbitration (FEAT-051): which reading of a page wins.
 *
 * Each qualifying reading — collection, table, detail, article — gets a
 * **mass**: the visible text it explains. The largest mass wins; ties break
 * `collection` > `table` > `detail` > `article`. Article text is discounted by
 * {@link ARTICLE_MASS_WEIGHT} because Readability run on a listing keeps
 * fragments of every card, so its raw length overstates how much of the page
 * is prose. With no qualifying reading, a page that still offers followable
 * links is an `index`; one that offers nothing is empty (`null`), which callers
 * report as `EXTRACTION_EMPTY`.
 */

import type { PageShape } from './types.js';

/** Discount on article text in arbitration: Readability on a listing keeps card fragments. */
export const ARTICLE_MASS_WEIGHT = 0.5;

/**
 * Least mass one label/value pair carries in arbitration. A field states one
 * fact in a few characters ("Drivetrain: AWD") that prose spends a sentence
 * on, so raw length understates how much of a detail page its attributes
 * explain; each pair counts as at least a short sentence's worth.
 */
export const FIELD_FACT_CHARS = 60;

/**
 * Arbitration mass of label/value pairs: each pair's text, floored at
 * {@link FIELD_FACT_CHARS}.
 *
 * @param fields The pairs.
 */
export function fieldMass(fields: readonly { label: string; value: string }[]): number {
  return fields.reduce(
    (total, field) => total + Math.max(FIELD_FACT_CHARS, field.label.length + field.value.length),
    0,
  );
}

/** Fields a page needs before it reads as a `detail` page. */
export const MIN_DETAIL_FIELDS = 4;

/** What the analyzer found, reduced to what arbitration weighs. */
export interface ShapeEvidence {
  /** Readability's article text length; null when there is no article. */
  readonly articleChars: number | null;
  /** Article prose: its letter/digit text not already returned as records, fields, tables, or links. */
  readonly articleProseChars: number;
  readonly records: { readonly count: number; readonly chars: number; readonly qualifies: boolean };
  readonly structuredCollection: {
    readonly count: number;
    readonly chars: number;
    readonly qualifies: boolean;
  };
  readonly tables: { readonly count: number; readonly chars: number };
  /** Page-level pairs: how many, their raw text, and their {@link fieldMass}. */
  readonly fields: { readonly count: number; readonly chars: number; readonly mass: number };
  readonly mainEntity: { readonly type: string; readonly chars: number } | null;
  /** Distinct links found that are not page chrome. */
  readonly followableLinks: number;
  /**
   * Parts below every threshold: non-layout tables, and fields plus
   * entities. A page holding only these is still not empty.
   */
  readonly minorParts: { readonly tables: number; readonly fields: number };
}

/** The winning shape and the sentence explaining it. */
export interface ShapeDecision {
  readonly shape: PageShape | null;
  readonly basis: string;
}

interface Reading {
  readonly shape: Exclude<PageShape, 'index'>;
  readonly mass: number;
  readonly describe: string;
}

const TIE_ORDER: readonly Reading['shape'][] = ['collection', 'table', 'detail', 'article'];

/**
 * Decides the page's shape.
 *
 * @param evidence What the analyzer found.
 * @returns The shape (null for an empty page) and a one-sentence basis naming
 *   the winner and the runner-up with both masses.
 */
export function classifyShape(evidence: ShapeEvidence): ShapeDecision {
  const readings: Reading[] = [];
  if (evidence.records.qualifies) {
    readings.push({
      shape: 'collection',
      mass: evidence.records.chars,
      describe: `${count(evidence.records.count)} repeated records (${count(evidence.records.chars)} chars)`,
    });
  } else if (evidence.structuredCollection.qualifies) {
    readings.push({
      shape: 'collection',
      mass: evidence.structuredCollection.chars,
      describe: `${count(evidence.structuredCollection.count)} structured entities (${count(evidence.structuredCollection.chars)} chars)`,
    });
  }
  if (evidence.tables.count > 0 && evidence.tables.chars > 0) {
    readings.push({
      shape: 'table',
      mass: evidence.tables.chars,
      describe: `${count(evidence.tables.count)} data table${evidence.tables.count === 1 ? '' : 's'} (${count(evidence.tables.chars)} chars)`,
    });
  }
  const fieldsQualify = evidence.fields.count >= MIN_DETAIL_FIELDS;
  if (fieldsQualify || evidence.mainEntity !== null) {
    const pairsMass = fieldsQualify ? evidence.fields.mass : 0;
    const entityMass = evidence.mainEntity?.chars ?? 0;
    const parts = [
      ...(fieldsQualify
        ? [
            `${count(evidence.fields.count)} label/value fields (${count(evidence.fields.chars)} chars, weighted ${count(pairsMass)})`,
          ]
        : []),
      ...(evidence.mainEntity === null
        ? []
        : [`one structured ${evidence.mainEntity.type} entity (${count(entityMass)} chars)`]),
    ];
    readings.push({ shape: 'detail', mass: pairsMass + entityMass, describe: parts.join(' and ') });
  }
  const prose = evidence.articleChars === null ? 0 : evidence.articleProseChars;
  // An article qualifies only with prose of its own: text that is nothing
  // but link labels or card fragments is not an article.
  if (evidence.articleChars !== null && prose > 0) {
    readings.push({
      shape: 'article',
      mass: prose * ARTICLE_MASS_WEIGHT,
      describe: `article text (${count(evidence.articleChars)} chars, ${count(prose)} not returned as records, fields, tables, or links)`,
    });
  }

  const ranked = readings.sort(
    (left, right) =>
      right.mass - left.mass || TIE_ORDER.indexOf(left.shape) - TIE_ORDER.indexOf(right.shape),
  );
  const [winner, runnerUp] = ranked;
  if (winner !== undefined) {
    return {
      shape: winner.shape,
      basis:
        runnerUp === undefined
          ? `${winner.shape}: ${winner.describe}; no other shape qualified`
          : `${winner.shape}: ${winner.describe} outweighed ${runnerUp.describe}`,
    };
  }
  if (evidence.minorParts.tables > 0) {
    return {
      shape: 'table',
      basis: 'table: a table below the data-table threshold is the only content',
    };
  }
  if (evidence.minorParts.fields > 0) {
    return {
      shape: 'detail',
      basis: 'detail: label/value data below the detail threshold is the only content',
    };
  }
  if (evidence.followableLinks > 0) {
    return {
      shape: 'index',
      basis: `index: no readable article, records, tables, fields, or structured data; ${count(evidence.followableLinks)} followable links`,
    };
  }
  return {
    shape: null,
    basis:
      'empty: no readable article, records, tables, fields, structured data, or followable links',
  };
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}
