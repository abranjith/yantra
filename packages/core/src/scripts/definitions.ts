/**
 * The default allowlisted transformation scripts (FEAT-024 TASK-006).
 *
 * Every `transform` here MUST be a pure, self-contained function: it is
 * serialized and reconstructed inside a worker, so it may reference only its
 * argument and JavaScript built-ins — no imports, closures, or `this`.
 */

import { z } from 'zod';

import { DEFAULT_SCRIPT_LIMITS, type ScriptDefinition } from './types.js';

/** `table_normalize` — parse delimited text into a trimmed `{ headers, rows }`. */
const tableNormalize: ScriptDefinition<{ text: string; delimiter: string; hasHeader: boolean }> = {
  id: 'table_normalize',
  description:
    'Parse delimited text (CSV/TSV) into a normalized { headers, rows } table with trimmed cells. ' +
    'Use to tidy scraped tabular text. Do NOT use for free-form prose or to fetch data.',
  argsSchema: z
    .object({
      text: z.string().min(1).max(200_000).describe('The delimited text to normalize.'),
      delimiter: z
        .string()
        .min(1)
        .max(4)
        .default(',')
        .describe('Field delimiter (e.g. "," or "\\t").'),
      hasHeader: z.boolean().default(true).describe('Treat the first row as a header row.'),
    })
    .strict(),
  limits: DEFAULT_SCRIPT_LIMITS,
  transform: (args) => {
    const lines = args.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const rows = lines.map((line) => line.split(args.delimiter).map((cell) => cell.trim()));
    if (rows.length === 0) return { headers: [], rows: [] };
    if (args.hasHeader) {
      const [headers, ...body] = rows;
      return { headers: headers ?? [], rows: body };
    }
    return { headers: [], rows };
  },
};

/** `dedupe_lines` — collapse duplicate lines, preserving first-seen order. */
const dedupeLines: ScriptDefinition<{ text: string; caseInsensitive: boolean }> = {
  id: 'dedupe_lines',
  description:
    'Remove duplicate lines from text, preserving first-seen order. ' +
    'Use to tidy list-shaped text. Do NOT use to summarize or reorder content.',
  argsSchema: z
    .object({
      text: z.string().min(1).max(200_000).describe('The text whose lines should be deduplicated.'),
      caseInsensitive: z.boolean().default(false).describe('Compare lines case-insensitively.'),
    })
    .strict(),
  limits: DEFAULT_SCRIPT_LIMITS,
  transform: (args) => {
    const seen = new Set();
    const out = [];
    for (const raw of args.text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      const key = args.caseInsensitive ? line.toLowerCase() : line;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return { lines: out, count: out.length };
  },
};

/** `json_pick` — project a subset of top-level keys from a JSON object. */
const jsonPick: ScriptDefinition<{ data: Record<string, unknown>; keys: string[] }> = {
  id: 'json_pick',
  description:
    'Return a new object containing only the named top-level keys of a JSON object. ' +
    'Use to trim a large object to the fields you need. Do NOT use for arrays or nested paths.',
  argsSchema: z
    .object({
      data: z.record(z.unknown()).describe('The source JSON object.'),
      keys: z.array(z.string().min(1)).min(1).max(100).describe('Top-level keys to keep.'),
    })
    .strict(),
  limits: DEFAULT_SCRIPT_LIMITS,
  transform: (args) => {
    const out: Record<string, unknown> = {};
    for (const key of args.keys) {
      if (Object.prototype.hasOwnProperty.call(args.data, key)) {
        out[key] = args.data[key];
      }
    }
    return out;
  },
};

/** The production allowlist of transformation scripts. */
export const DEFAULT_SCRIPTS: readonly ScriptDefinition[] = [
  tableNormalize as ScriptDefinition,
  dedupeLines as ScriptDefinition,
  jsonPick as ScriptDefinition,
];
