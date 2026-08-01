/**
 * Runtime validation for template slot values beyond the generated schema.
 *
 * The provider schema owns required keys and coarse types. This module enforces
 * content bounds, table arity, ledger-resolved citations/URLs, and inert-output
 * hygiene. Issues use the same slash-pointer shape as Brief validation so the
 * existing bounded correction loop can feed them back to the model unchanged.
 */

import type { BriefSource, TemplateManifest, TemplateSlot } from '@yantra/protocol';

/** One correctable validation issue in a model-filled template report. */
export interface TemplateSlotIssue {
  /** Path segments beginning with `report`. */
  readonly path: readonly (string | number)[];
  /** Slash-joined issue path (for example `report/risks/2`). */
  readonly pointer: string;
  /** Actionable issue description. */
  readonly message: string;
}

/**
 * Validate model-filled slots against a manifest and engine-owned source ledger.
 *
 * @param manifest Active parsed template.
 * @param values Candidate object under the tool's `report` key.
 * @param sources Engine-owned, numbered source records.
 * @returns Every structural, constraint, citation, URL, ANSI, and placeholder issue.
 */
export function validateSlots(
  manifest: TemplateManifest,
  values: unknown,
  sources: readonly BriefSource[],
): TemplateSlotIssue[] {
  const issues: TemplateSlotIssue[] = [];
  const record = asRecord(values);
  if (record === undefined) {
    addIssue(issues, ['report'], 'must be an object of template slot values');
    return issues;
  }

  const declared = new Set(
    manifest.slots.filter((slot) => slot.kind !== 'sources').map((slot) => slot.key),
  );
  for (const key of Object.keys(record)) {
    if (key !== 'sources' && !declared.has(key)) {
      addIssue(issues, ['report', key], 'is not declared by the active template');
    }
  }

  const allowedUrls = new Set<string>();
  for (const source of sources) {
    allowedUrls.add(source.url);
    if (source.final_url !== null) allowedUrls.add(source.final_url);
  }

  for (const slot of manifest.slots) {
    if (slot.kind === 'sources') continue;
    const path: (string | number)[] = ['report', slot.key];
    const value = record[slot.key];
    if (value === undefined) {
      addIssue(issues, path, 'is required by the active template');
      continue;
    }
    validateSlot(slot, value, path, sources.length, allowedUrls, issues);
  }
  return issues;
}

function validateSlot(
  slot: TemplateSlot,
  value: unknown,
  path: readonly (string | number)[],
  sourceCount: number,
  allowedUrls: ReadonlySet<string>,
  issues: TemplateSlotIssue[],
): void {
  switch (slot.kind) {
    case 'text':
    case 'markdown':
      if (typeof value !== 'string') {
        addIssue(issues, path, `must be a string for kind ${slot.kind}`);
        return;
      }
      validateString(value, slot, path, sourceCount, allowedUrls, issues);
      return;
    case 'list':
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
        addIssue(issues, path, 'must be an array of strings for kind list');
        return;
      }
      validateCount(value.length, slot, path, 'items', issues);
      value.forEach((entry, index) =>
        validateString(entry, slot, [...path, index], sourceCount, allowedUrls, issues),
      );
      return;
    case 'table': {
      if (!Array.isArray(value) || !value.every((row) => Array.isArray(row))) {
        addIssue(issues, path, 'must be an array of string rows for kind table');
        return;
      }
      validateCount(value.length, slot, path, 'rows', issues);
      const arity = slot.columns?.length ?? 0;
      value.forEach((row, rowIndex) => {
        const rowPath = [...path, rowIndex];
        if (!row.every((cell) => typeof cell === 'string')) {
          addIssue(issues, rowPath, 'must contain only string cells');
          return;
        }
        if (row.length !== arity) {
          addIssue(issues, rowPath, `row has ${row.length} cells; expected exactly ${arity}`);
        }
        row.forEach((cell, cellIndex) =>
          validateString(cell, slot, [...rowPath, cellIndex], sourceCount, allowedUrls, issues),
        );
      });
      return;
    }
    case 'sources':
      return;
  }
}

function validateCount(
  count: number,
  slot: TemplateSlot,
  path: readonly (string | number)[],
  label: string,
  issues: TemplateSlotIssue[],
): void {
  const { min, max } = slot.constraints;
  if (min !== undefined && count < min)
    addIssue(issues, path, `has ${count} ${label}; minimum is ${min}`);
  if (max !== undefined && count > max)
    addIssue(issues, path, `has ${count} ${label}; maximum is ${max}`);
}

function validateString(
  value: string,
  slot: TemplateSlot,
  path: readonly (string | number)[],
  sourceCount: number,
  allowedUrls: ReadonlySet<string>,
  issues: TemplateSlotIssue[],
): void {
  const { minChars, maxChars, minWords, maxWords } = slot.constraints;
  const chars = [...value].length;
  const words = wordCount(value);
  if (minChars !== undefined && chars < minChars)
    addIssue(issues, path, `has ${chars} characters; minimum is ${minChars}`);
  if (maxChars !== undefined && chars > maxChars)
    addIssue(issues, path, `has ${chars} characters; maximum is ${maxChars}`);
  if (minWords !== undefined && words < minWords)
    addIssue(issues, path, `has ${words} words; minimum is ${minWords}`);
  if (maxWords !== undefined && words > maxWords)
    addIssue(issues, path, `has ${words} words; maximum is ${maxWords}`);

  for (const match of value.matchAll(/\[(\d+)\]/gu)) {
    const citation = Number(match[1]);
    if (!Number.isSafeInteger(citation) || citation < 1 || citation > sourceCount) {
      addIssue(
        issues,
        path,
        `citation [${match[1]}] does not resolve to sources 1..${sourceCount}`,
      );
    }
  }
  for (const match of value.matchAll(/https?:\/\/[^\s<>{}]+/giu)) {
    const url = (match[0] ?? '').replace(/[),.;:!?]+$/u, '');
    if (!allowedUrls.has(url))
      addIssue(issues, path, `URL ${url} is not present in the evidence ledger`);
  }
  // eslint-disable-next-line no-control-regex -- raw ANSI bytes are the exact unsafe input
  if (/[\u001b\u009b]/u.test(value))
    addIssue(issues, path, 'must not contain raw ANSI escape bytes');
  if (/\{\{.*?\}\}/su.test(value))
    addIssue(issues, path, 'must not echo template placeholder syntax');
}

function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

function addIssue(
  issues: TemplateSlotIssue[],
  path: readonly (string | number)[],
  message: string,
): void {
  issues.push({ path: [...path], pointer: path.join('/'), message });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
