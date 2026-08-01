/**
 * Pure parser for Yantra report templates.
 *
 * Grammar: an optional YAML frontmatter block is followed by Markdown carrying
 * `{{ key }}` or `{{ key | kind, constraint=value }}` placeholders. Table kinds
 * use `table(Column A, Column B)`. While scanning, the parser records the
 * enclosing ATX heading path because that path becomes the model's only
 * semantic description of each otherwise-arbitrary slot key.
 */

import { createHash } from 'node:crypto';

import { TemplateManifest, type Result, type TemplateSlot, err, ok } from '@yantra/protocol';
import { parseDocument } from 'yaml';

/** A line-addressable report-template syntax or metadata error. */
export interface TemplateParseError {
  /** One-based line number in the complete raw template. */
  readonly line: number;
  /** Actionable description of the invalid construct. */
  readonly message: string;
}

/** Normalized metadata extracted from optional YAML frontmatter. */
interface ParsedFrontmatter {
  readonly name: string | null;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly body: string;
  readonly bodyStartLine: number;
}

const TEMPLATE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLOT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

type ConstraintField = 'minChars' | 'maxChars' | 'minWords' | 'maxWords' | 'min' | 'max';

const CONSTRAINT_KEYS = new Map<string, ConstraintField>([
  ['min_chars', 'minChars'],
  ['max_chars', 'maxChars'],
  ['min_words', 'minWords'],
  ['max_words', 'maxWords'],
  ['min', 'min'],
  ['max', 'max'],
]);

/**
 * Normalize a user-facing name or tag to Yantra's lowercase slug form.
 *
 * @param value Raw YAML/CLI value.
 * @returns A lowercase hyphenated slug (possibly empty when no slug characters remain).
 */
export function normalizeTemplateSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * Normalize, deduplicate, and sort template tags.
 *
 * @param values Raw tag strings.
 * @returns Stable lowercase slug tags.
 */
export function normalizeTemplateTags(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeTemplateSlug).filter((tag) => tag.length > 0))].sort();
}

/**
 * Parse raw Markdown template text into a validated slot manifest.
 *
 * This function performs no I/O and never throws. All YAML, grammar, duplicate,
 * and constraint failures are returned together with one-based line numbers.
 *
 * @param text Complete raw template file contents.
 * @returns A validated manifest or every parse error found.
 */
export function parseTemplate(text: string): Result<TemplateManifest, TemplateParseError[]> {
  const frontmatter = parseFrontmatter(text);
  if (!frontmatter.isOk) return frontmatter;

  const errors: TemplateParseError[] = [];
  const slots: TemplateSlot[] = [];
  const seen = new Map<string, number>();
  const headings: string[] = [];

  for (const line of sourceLines(frontmatter.value.body)) {
    const lineNumber = frontmatter.value.bodyStartLine + line.index;
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line.content);
    if (heading !== null) {
      const depth = heading[1]?.length ?? 1;
      const staticHeading = (heading[2] ?? '')
        .replace(/\{\{.*?\}\}/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
      headings.length = Math.min(headings.length, depth - 1);
      if (staticHeading.length > 0) headings[depth - 1] = staticHeading;
    }

    const matchedRanges: { start: number; end: number }[] = [];
    const placeholder = /\{\{(.*?)\}\}/gu;
    for (const match of line.content.matchAll(placeholder)) {
      const index = match.index ?? 0;
      matchedRanges.push({ start: index, end: index + match[0].length });
      const parsed = parseSlot(match[1] ?? '', lineNumber, headings.filter(Boolean));
      if (!parsed.isOk) {
        errors.push(...parsed.error);
        continue;
      }
      const priorLine = seen.get(parsed.value.key);
      if (priorLine !== undefined) {
        errors.push({
          line: lineNumber,
          message: `duplicate slot key "${parsed.value.key}" (first declared on line ${priorLine})`,
        });
        continue;
      }
      seen.set(parsed.value.key, lineNumber);
      slots.push({ ...parsed.value, offset: line.start + index });
    }

    const unmatched = maskRanges(line.content, matchedRanges);
    const malformedAt = unmatched.indexOf('{{');
    if (malformedAt >= 0) {
      errors.push({ line: lineNumber, message: 'malformed placeholder: missing closing "}}"' });
    }
    const strayCloseAt = unmatched.indexOf('}}');
    if (strayCloseAt >= 0) {
      errors.push({
        line: lineNumber,
        message: 'malformed placeholder: closing "}}" has no opening',
      });
    }
  }

  if (slots.length === 0) {
    errors.push({
      line: frontmatter.value.bodyStartLine,
      message: 'template must declare at least one slot',
    });
  }

  if (errors.length > 0) return err(errors);

  const candidate = {
    name: frontmatter.value.name,
    description: frontmatter.value.description,
    tags: [...frontmatter.value.tags],
    slots,
    body: frontmatter.value.body,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
  const validated = TemplateManifest.safeParse(candidate);
  if (validated.success) return ok(validated.data);
  return err(
    validated.error.issues.map((issue) => ({
      line: 1,
      message: `${issue.path.join('/') || 'template'}: ${issue.message}`,
    })),
  );
}

function parseFrontmatter(text: string): Result<ParsedFrontmatter, TemplateParseError[]> {
  const lines = sourceLines(text);
  if (lines.length === 0 || lines[0]?.content.replace(/^\uFEFF/u, '').trim() !== '---') {
    return ok({ name: null, description: null, tags: [], body: text, bodyStartLine: 1 });
  }

  const closingIndex = lines.slice(1).findIndex((line) => line.content.trim() === '---');
  if (closingIndex < 0) {
    return err([{ line: 1, message: 'YAML frontmatter is missing its closing --- delimiter' }]);
  }
  const closing = closingIndex + 1;
  const first = lines[0];
  const closingLine = lines[closing];
  if (first === undefined || closingLine === undefined) {
    return err([{ line: 1, message: 'YAML frontmatter could not be read' }]);
  }
  const yamlText = text.slice(first.end, closingLine.start);
  const document = parseDocument(yamlText);
  if (document.errors.length > 0) {
    return err(
      document.errors.map((error) => ({
        line: (error.linePos?.[0].line ?? 1) + 1,
        message: `malformed YAML frontmatter: ${error.message.split('\n')[0]}`,
      })),
    );
  }

  const value = document.toJS() as unknown;
  const record = asRecord(value);
  if (value !== null && record === undefined) {
    return err([{ line: 2, message: 'YAML frontmatter must be a mapping' }]);
  }

  const errors: TemplateParseError[] = [];
  const rawName = record?.name;
  let name: string | null = null;
  if (rawName !== undefined && rawName !== null) {
    if (typeof rawName !== 'string') {
      errors.push({ line: 2, message: 'frontmatter name must be a string' });
    } else {
      name = normalizeTemplateSlug(rawName);
      if (!TEMPLATE_NAME_PATTERN.test(name)) {
        errors.push({
          line: 2,
          message: 'frontmatter name must normalize to a 1-64 character slug',
        });
      }
    }
  }

  const rawDescription = record?.description;
  let description: string | null = null;
  if (rawDescription !== undefined && rawDescription !== null) {
    if (typeof rawDescription !== 'string') {
      errors.push({ line: 2, message: 'frontmatter description must be a string' });
    } else {
      description = rawDescription.replace(/\s+/gu, ' ').trim() || null;
    }
  }

  const rawTags = record?.tags;
  let tags: string[] = [];
  if (rawTags !== undefined && rawTags !== null) {
    const tagValues =
      typeof rawTags === 'string'
        ? rawTags.split(',')
        : Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === 'string')
          ? rawTags
          : null;
    if (tagValues === null) {
      errors.push({ line: 2, message: 'frontmatter tags must be a string or string array' });
    } else {
      tags = normalizeTemplateTags(tagValues);
      const invalid = tags.find((tag) => !TEMPLATE_NAME_PATTERN.test(tag));
      if (invalid !== undefined) {
        errors.push({ line: 2, message: `tag "${invalid}" exceeds the 64 character slug limit` });
      }
    }
  }

  if (errors.length > 0) return err(errors);
  return ok({
    name,
    description,
    tags,
    body: text.slice(closingLine.end),
    bodyStartLine: closing + 2,
  });
}

function parseSlot(
  raw: string,
  line: number,
  headingPath: readonly string[],
): Result<Omit<TemplateSlot, 'offset'>, TemplateParseError[]> {
  const pieces = raw.split('|');
  if (pieces.length > 2) {
    return err([{ line, message: 'slot syntax may contain only one "|" qualifier separator' }]);
  }
  const key = (pieces[0] ?? '').trim();
  if (!SLOT_KEY_PATTERN.test(key)) {
    return err([{ line, message: `invalid slot key "${key}"; expected ^[a-z][a-z0-9_]{0,47}$` }]);
  }

  const qualifier = pieces[1]?.trim();
  const parts = qualifier === undefined || qualifier.length === 0 ? [] : splitTopLevel(qualifier);
  const kindToken = parts.shift();
  let kind: TemplateSlot['kind'] = key === 'sources' ? 'sources' : 'markdown';
  let columns: string[] | null = null;
  const errors: TemplateParseError[] = [];

  if (kindToken !== undefined) {
    const table = /^table\((.*)\)$/u.exec(kindToken);
    if (table !== null) {
      kind = 'table';
      columns = (table[1] ?? '')
        .split(',')
        .map((column) => column.trim())
        .filter((column) => column.length > 0);
      if (columns.length === 0)
        errors.push({ line, message: 'table slots require at least one column' });
    } else if (
      kindToken === 'text' ||
      kindToken === 'markdown' ||
      kindToken === 'list' ||
      kindToken === 'sources'
    ) {
      kind = kindToken;
    } else {
      errors.push({ line, message: `unknown slot kind "${kindToken}"` });
    }
  }

  if (key === 'sources' && kind !== 'sources') {
    errors.push({ line, message: 'the reserved sources slot cannot declare a conflicting kind' });
  }
  if (key !== 'sources' && kind === 'sources') {
    errors.push({ line, message: 'kind sources is reserved for the sources slot' });
  }

  const constraints: Record<string, number> = {};
  for (const constraint of parts) {
    const match = /^([a-z_]+)\s*=\s*(.+)$/u.exec(constraint);
    if (match === null) {
      errors.push({ line, message: `invalid constraint "${constraint}"; expected name=value` });
      continue;
    }
    const field = CONSTRAINT_KEYS.get(match[1] ?? '');
    if (field === undefined) {
      errors.push({ line, message: `unknown constraint "${match[1]}"` });
      continue;
    }
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) {
      errors.push({ line, message: `constraint "${match[1]}" must be a non-negative integer` });
      continue;
    }
    constraints[field] = value;
  }

  checkBounds(constraints, 'minChars', 'maxChars', line, errors);
  checkBounds(constraints, 'minWords', 'maxWords', line, errors);
  checkBounds(constraints, 'min', 'max', line, errors);
  if (errors.length > 0) return err(errors);
  return ok({
    key,
    kind,
    headingPath: [...headingPath],
    columns,
    constraints,
  });
}

function checkBounds(
  constraints: Readonly<Record<string, number>>,
  minKey: string,
  maxKey: string,
  line: number,
  errors: TemplateParseError[],
): void {
  const min = constraints[minKey];
  const max = constraints[maxKey];
  if (min !== undefined && max !== undefined && min > max) {
    errors.push({ line, message: `${minKey} cannot exceed ${maxKey}` });
  }
}

function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(input.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

interface SourceLine {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /[^\r\n]*(?:\r\n|\n|$)/gu;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    const start = match.index ?? 0;
    lines.push({
      index,
      start,
      end: start + match[0].length,
      content: match[0].replace(/\r?\n$/u, ''),
    });
    index += 1;
  }
  return lines;
}

function maskRanges(text: string, ranges: readonly { start: number; end: number }[]): string {
  const chars = text.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) chars[index] = ' ';
  }
  return chars.join('');
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
