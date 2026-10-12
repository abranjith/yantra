/**
 * Page analysis orchestration (FEAT-051).
 *
 * {@link analyzePage} runs over the extractor's own cheerio parse **before**
 * Readability's pre-clean, because the pre-clean deletes the `nav`, `aside`,
 * `form`, and `script` elements that hold pagination, facets, and JSON-LD. It
 * is pure: it reads the tree and never mutates it, so the pre-clean and
 * Readability that follow see exactly the parse they saw before this feature.
 * {@link completeAnalysis} then folds in Readability's result and decides the
 * shape. Together they add zero HTML parses to a read.
 */

import type { CheerioAPI } from 'cheerio';

import { PageIndex, type PageNode } from './dom.js';
import { fieldChars, pageFields, type FieldScan, MAX_FIELDS } from './fields.js';
import {
  MAX_LINKS,
  classifyLinks,
  harvestLinks,
  summarizeLinks,
  type LinkSummary,
} from './links.js';
import { MAX_RECORDS, MIN_RECORDS, scanRecords, type RecordScan } from './records.js';
import { classifyShape, fieldMass } from './shape.js';
import { MAX_STRUCTURED, entityChars, readStructured, type StructuredScan } from './structured.js';
import { MAX_TABLES, dataTableChars, readTables, type TableScan } from './tables.js';
import type { LinkKind, Omission, PageAnalysis, PageCoverage, PageTable } from './types.js';

/** Fixed `not_found` phrases: what was looked for and absent. */
export const NOT_FOUND = Object.freeze({
  records: 'no repeated records',
  structured: 'no structured data',
  tables: 'no tables',
  fields: 'no label/value fields',
  links: 'no followable links',
  article: 'no readable article',
});

/** Options for {@link analyzePage}. */
export interface AnalyzeOptions {
  /** The page's final URL, used to resolve links when there is no `<base href>`. */
  readonly baseUrl: string;
  readonly fetchMode: 'http' | 'browser';
}

/** Everything analysis found before Readability's verdict is known. */
export interface PageScan {
  readonly options: AnalyzeOptions;
  readonly records: RecordScan;
  readonly links: LinkSummary;
  readonly tables: TableScan;
  readonly fields: FieldScan;
  readonly structured: StructuredScan;
}

/** Readability's verdict and the no-article fallback text. */
export interface ArticleInput {
  /** Readability's `contentText`, or null when it found no article. */
  readonly articleText: string | null;
  /** The pre-cleaned body's block-structured visible text, used when there is no article. */
  readonly fallbackText: string;
  /** Set when the HTML handed to analysis was cut at a byte cap (a live snapshot). */
  readonly truncatedSource?: boolean;
}

/**
 * Reads links, records, structured data, tables, and fields from the parse.
 * Pure: `$.html()` is identical before and after.
 *
 * @param $ The extractor's parse, untouched by any pre-clean.
 * @param options The page URL and fetch mode.
 */
export function analyzePage($: CheerioAPI, options: AnalyzeOptions): PageScan {
  const index = new PageIndex($);
  const { candidates, selfLinks } = harvestLinks(index, options.baseUrl);
  const byNode = new Map(candidates.map((candidate) => [candidate.node, candidate] as const));
  const records = scanRecords(index, options.baseUrl, byNode, selfLinks);
  const kinds: Map<PageNode, LinkKind> = classifyLinks(index, options.baseUrl, candidates);
  for (const [node, kind] of records.kinds) kinds.set(node, kind);
  const links = summarizeLinks(options.baseUrl, candidates, kinds);
  const tables = readTables(index);
  const fields = pageFields(
    index,
    tables.reads.map((read) => read.table),
  );
  const structured = readStructured(index);
  return { options, records, links, tables, fields, structured };
}

/**
 * Decides the shape and assembles the {@link PageAnalysis}.
 *
 * @param scan The result of {@link analyzePage}.
 * @param input Readability's verdict and the fallback text.
 */
export function completeAnalysis(scan: PageScan, input: ArticleInput): PageAnalysis {
  const { records, links, tables, fields, structured } = scan;
  const shownTables: PageTable[] = tables.reads.map((read) => read.table);
  const articleText = input.articleText;

  const tableChars = dataTableChars(shownTables);
  const qualifyingTables = shownTables.filter((table) => dataTableChars([table]) > 0).length;
  const collectionFromStructured =
    structured.largestList >= MIN_RECORDS || structured.topLevelSameRoot >= MIN_RECORDS;
  const mainEntity =
    structured.mainEntities.length === 1 && structured.mainEntities[0] !== undefined
      ? structured.mainEntities[0]
      : null;
  const listedEntities = structured.entities.filter((entity) => entity.type !== 'ItemList');
  const followableLinks = links.found - (links.byKind.navigation ?? 0);

  const decision = classifyShape({
    articleChars: articleText === null ? null : articleText.length,
    articleProseChars: articleText === null ? 0 : proseChars(articleText, scan, shownTables),
    records: {
      count: records.found,
      chars: records.chars,
      qualifies: records.found >= MIN_RECORDS,
    },
    structuredCollection: {
      count: listedEntities.length,
      chars: entityChars(listedEntities),
      qualifies: collectionFromStructured,
    },
    tables: { count: qualifyingTables, chars: tableChars },
    fields: {
      count: fields.found,
      chars: fieldChars(fields.fields),
      mass: fieldMass(fields.fields),
    },
    mainEntity:
      mainEntity === null ? null : { type: mainEntity.type, chars: entityChars([mainEntity]) },
    followableLinks,
    minorParts: {
      tables: shownTables.filter((table) => table.kind !== 'layout' && table.rows.length > 0)
        .length,
      fields: fields.found + structured.found,
    },
  });

  const readableText = articleText ?? input.fallbackText;
  const paginationOffered = links.links.some((link) => link.kind === 'pagination');
  const omitted: Omission[] = [];
  if (input.truncatedSource === true) omitted.push({ id: 'snapshot-truncated', count: 1 });
  if (records.found > MAX_RECORDS) {
    omitted.push({
      id: 'records-beyond-limit',
      count: records.found - MAX_RECORDS,
      paginationOffered,
    });
  }
  if (records.truncated > 0) omitted.push({ id: 'record-text-cut', count: records.truncated });
  if (links.found - links.recordLinkCount > MAX_LINKS) {
    omitted.push({
      id: 'links-beyond-limit',
      count: links.found - links.recordLinkCount - MAX_LINKS,
    });
  }
  if (tables.found > MAX_TABLES) {
    omitted.push({ id: 'tables-beyond-limit', count: tables.found - MAX_TABLES });
  }
  for (const read of tables.reads) {
    if (read.rowsDropped > 0) {
      omitted.push({
        id: 'table-rows-beyond-limit',
        count: read.rowsDropped,
        table: read.table.index,
      });
    }
    if (read.colsDropped) {
      omitted.push({ id: 'table-columns-beyond-limit', count: 1, table: read.table.index });
    }
  }
  if (structured.found > MAX_STRUCTURED) {
    omitted.push({ id: 'structured-beyond-limit', count: structured.found - MAX_STRUCTURED });
  }
  if (structured.skippedBytes > 0) {
    omitted.push({ id: 'structured-blocks-skipped', count: structured.skippedBytes });
  }
  if (fields.found > MAX_FIELDS) {
    omitted.push({ id: 'fields-beyond-limit', count: fields.found - MAX_FIELDS });
  }

  const notFound: string[] = [];
  if (records.found === 0) notFound.push(NOT_FOUND.records);
  if (structured.found === 0) notFound.push(NOT_FOUND.structured);
  if (tables.found === 0) notFound.push(NOT_FOUND.tables);
  if (fields.found === 0) notFound.push(NOT_FOUND.fields);
  if (links.found === 0) notFound.push(NOT_FOUND.links);
  if (articleText === null) notFound.push(NOT_FOUND.article);

  const coverage: PageCoverage = {
    shape_basis: decision.basis,
    fetch_mode: scan.options.fetchMode,
    ...(records.found > 0
      ? {
          records: {
            found: records.found,
            shown: records.records.length,
            with_link: records.records.filter((record) => record.url !== null).length,
            with_fields: records.records.filter((record) => record.fields.length > 0).length,
            truncated: records.truncated,
            other_regions: records.otherRegions,
          },
        }
      : {}),
    ...(links.found > 0
      ? {
          links: {
            found: links.found,
            shown: links.links.length,
            withheld: 0,
            by_kind: links.byKind,
          },
        }
      : {}),
    ...(tables.found > 0 ? { tables: { found: tables.found, shown: shownTables.length } } : {}),
    ...(structured.found > 0 || structured.malformed > 0
      ? {
          structured: {
            found: structured.found,
            shown: structured.entities.length,
            types: structured.types,
            ignored_types: structured.ignoredTypes,
            malformed: structured.malformed,
            skipped_bytes: structured.skippedBytes,
          },
        }
      : {}),
    ...(fields.found > 0 ? { fields: { found: fields.found, shown: fields.fields.length } } : {}),
    ...(readableText.length > 0
      ? { text: { chars: readableText.length, shown: readableText.length } }
      : {}),
    not_found: notFound,
    omitted,
  };

  return {
    shape: decision.shape,
    records: records.records,
    structured: structured.entities,
    tables: shownTables,
    fields: fields.fields,
    links: links.links,
    recordLinkCount: links.recordLinkCount,
    readableText,
    coverage,
  };
}

/**
 * Article prose: what remains of the article text once the pieces other parts
 * already return are removed — record titles and segments, field labels and
 * values, table cells, and offered link labels — counted as letter/digit runs
 * joined by single spaces. A card fragment Readability kept is not prose, an
 * attribute list is not either, and neither is a hub's list of link labels.
 */
function proseChars(articleText: string, scan: PageScan, tables: readonly PageTable[]): number {
  const pieces = new Set<string>();
  for (const record of scan.records.records) {
    if (record.title !== null) pieces.add(record.title);
    for (const segment of record.segments) pieces.add(segment);
    for (const field of record.fields) pieces.add(field.value);
  }
  for (const field of scan.fields.fields) {
    pieces.add(field.label);
    pieces.add(field.value);
  }
  for (const table of tables) {
    for (const cell of [...table.headers, ...table.rows.flat()]) pieces.add(cell);
  }
  for (const link of scan.links.links) pieces.add(link.text);
  let rest = articleText;
  const ordered = [...pieces]
    .filter((piece) => piece.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const piece of ordered) rest = rest.replaceAll(piece, ' ');
  return rest.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().length;
}
