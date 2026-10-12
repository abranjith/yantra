/**
 * Label/value pairs (FEAT-051): the data a detail page holds.
 *
 * A product or vehicle page states its facts as attributes — "Exterior color:
 * Glacier White" — in a definition list, a two-column table, or plain
 * "Label: value" lines. These primitives read all three structurally; the
 * record module uses them per record, and {@link pageFields} reads them for
 * the whole page.
 */

import { cleanRun, elementChildren, tagOf, type PageIndex, type PageNode } from './dom.js';
import type { PageField, PageTable } from './types.js';

/** Page-level pairs shown: a detail page's attributes with room to spare. */
export const MAX_FIELDS = 60;

/** Characters in a label: a label names an attribute, it does not describe it. */
export const LABEL_MAX = 40;

/** Characters in a value, so one long value cannot crowd out the rest. */
export const VALUE_MAX = 200;

/** Words in a "Label: value" label; longer prefixes are sentences, not labels. */
const LABEL_WORDS_MAX = 5;

/** A pair plus the elements whose text it accounts for (excluded from record segments). */
export interface SourcedField {
  readonly field: PageField;
  readonly nodes: readonly PageNode[];
}

/**
 * Parses a "Label: value" run. The label must hold a letter, be at most
 * {@link LABEL_WORDS_MAX} words and {@link LABEL_MAX} characters, and the
 * value must be non-empty; a URL scheme is never a label.
 *
 * @param run One cleaned text run.
 * @returns The pair, or null when the run is not one.
 */
export function parseLabelValue(run: string): PageField | null {
  const match = /^([^:]{1,40}):\s+(\S.*)$/u.exec(run);
  if (match === null) return null;
  const label = (match[1] ?? '').trim();
  const value = (match[2] ?? '').trim();
  if (!/\p{L}/u.test(label) || /^https?$/iu.test(label)) return null;
  if (label.split(/\s+/u).length > LABEL_WORDS_MAX || label.length > LABEL_MAX) return null;
  return makeField(label, value);
}

/**
 * Pairs from every `dl` under (or at) `scope`: each `dt` with its following
 * `dd` siblings (several `dd` values join with `, `).
 *
 * @param index The page index.
 * @param scope The subtree to read.
 */
export function definitionPairs(index: PageIndex, scope: PageNode): SourcedField[] {
  const lists =
    tagOf(scope) === 'dl' ? [scope] : index.within(scope, (node) => tagOf(node) === 'dl');
  const out: SourcedField[] = [];
  for (const list of lists) {
    if (index.factsOf(list).hidden) continue;
    let term: PageNode | null = null;
    let values: PageNode[] = [];
    const emit = (): void => {
      if (term === null || values.length === 0) return;
      const label = index.textOf(term);
      const value = values
        .map((node) => index.textOf(node))
        .filter(Boolean)
        .join(', ');
      const field = makeField(label, value);
      if (field !== null) out.push({ field, nodes: [term, ...values] });
    };
    // A `div` may wrap each dt/dd group (allowed by HTML); look through it.
    const items = elementChildren(list).flatMap((child) =>
      tagOf(child) === 'div' ? elementChildren(child) : [child],
    );
    for (const item of items) {
      const tag = tagOf(item);
      if (tag === 'dt') {
        emit();
        term = item;
        values = [];
      } else if (tag === 'dd' && term !== null) {
        values.push(item);
      }
    }
    emit();
  }
  return out;
}

/**
 * The pair a two-cell table row states: the first cell is a `th` or a short
 * label (at most {@link LABEL_MAX} characters).
 *
 * @param index The page index.
 * @param row A `tr` element.
 */
export function cellPair(index: PageIndex, row: PageNode): SourcedField | null {
  const cells = rowCells(row);
  if (cells.length !== 2) return null;
  const [first, second] = cells;
  if (first === undefined || second === undefined) return null;
  const label = index.textOf(first);
  if (tagOf(first) !== 'th' && label.length > LABEL_MAX) return null;
  const field = makeField(label, index.textOf(second));
  return field === null ? null : { field, nodes: [row] };
}

/** The `td`/`th` children of a row. */
export function rowCells(row: PageNode): PageNode[] {
  return elementChildren(row).filter((cell) => {
    const tag = tagOf(cell);
    return tag === 'td' || tag === 'th';
  });
}

/** Page-level fields: the pairs found and those shown. */
export interface FieldScan {
  readonly fields: readonly PageField[];
  readonly found: number;
}

/**
 * Page-level label/value pairs: `dl` pairs, `key-value` table rows, and
 * "Label: value" lines in visible text outside landmarks (page chrome is not
 * the item's attributes). A repeated label+value pair is kept once; bounded
 * at {@link MAX_FIELDS}.
 *
 * @param index The page index.
 * @param tables The page's tables, already classified.
 */
export function pageFields(index: PageIndex, tables: readonly PageTable[]): FieldScan {
  const body = index.body();
  const found: PageField[] = [];
  for (const { field } of definitionPairs(index, body)) found.push(field);
  for (const table of tables) {
    if (table.kind !== 'key-value') continue;
    for (const [label, value] of table.rows) {
      const field = makeField(label ?? '', value ?? '');
      if (field !== null) found.push(field);
    }
  }
  const structuredContainers = new Set(['dl', 'table']);
  for (const run of index.runsOf(body, {
    skipLandmarks: true,
    exclude: (node) => structuredContainers.has(tagOf(node)),
  })) {
    const field = parseLabelValue(run);
    if (field !== null) found.push(field);
  }
  const seen = new Set<string>();
  const unique = found.filter((field) => {
    const key = JSON.stringify([field.label.toLowerCase(), field.value.toLowerCase()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { fields: unique.slice(0, MAX_FIELDS), found: unique.length };
}

/** Text a field contributes to shape mass: label plus value. */
export function fieldChars(fields: readonly PageField[]): number {
  return fields.reduce((total, field) => total + field.label.length + field.value.length, 0);
}

/** Builds a bounded pair; a trailing colon leaves the label. Null when either side is empty. */
function makeField(rawLabel: string, rawValue: string): PageField | null {
  const label = cleanRun(rawLabel).replace(/\s*:$/u, '').slice(0, LABEL_MAX).trim();
  const value = cleanRun(rawValue).slice(0, VALUE_MAX).trim();
  return label.length === 0 || value.length === 0 ? null : { label, value };
}
