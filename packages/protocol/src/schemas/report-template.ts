/**
 * Protocol schemas for user-authored report templates and their rendered
 * `document.*` artifacts.
 *
 * A template is parsed into a manifest whose model-owned slots become the
 * provider tool schema. The rendered report reuses Brief provenance records so
 * source numbering, usage accounting, and notices retain one stable contract.
 */

import { z } from 'zod';

import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { ULID_PATTERN } from '../utils/ulid.js';

import { BRIEF_SCHEMA_VERSION, BriefMetadata, BriefNotice, BriefSource } from './brief.js';

/** Supported model/engine value shapes declared by a template slot. */
export const TemplateSlotKind = z.enum(['text', 'markdown', 'list', 'table', 'sources']);

/** Numeric constraints supported by the template grammar. */
export const TemplateSlotConstraints = z
  .object({
    minChars: z.number().int().nonnegative().optional(),
    maxChars: z.number().int().nonnegative().optional(),
    minWords: z.number().int().nonnegative().optional(),
    maxWords: z.number().int().nonnegative().optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  })
  .strict()
  .describe('Optional character, word, item, or row bounds declared on a slot.');

/** One placeholder declaration in a parsed report template. */
export const TemplateSlot = z
  .object({
    key: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,47}$/)
      .describe('Unique model-facing slot key.'),
    kind: TemplateSlotKind.describe('Value shape rendered into this placeholder.'),
    headingPath: z
      .array(z.string().min(1))
      .describe('Enclosing ATX headings, outermost first, used as the model description.'),
    columns: z
      .array(z.string().min(1))
      .min(1)
      .nullable()
      .describe('Table column labels, or null for non-table slots.'),
    constraints: TemplateSlotConstraints,
    guidance: z
      .string()
      .min(1)
      .nullable()
      .describe("Optional author guidance appended to this slot's model description, or null."),
    offset: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Character offset of the opening placeholder in manifest.body after guidance directives are removed.',
      ),
  })
  .superRefine((slot, ctx) => {
    if (slot.kind === 'table' && slot.columns === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: 'table slots require at least one column',
      });
    }
    if (slot.kind !== 'table' && slot.columns !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['columns'],
        message: 'columns are only legal on table slots',
      });
    }
    if (slot.key === 'sources' && slot.kind !== 'sources') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'the reserved sources slot must use kind sources',
      });
    }
    if (slot.key !== 'sources' && slot.kind === 'sources') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['kind'],
        message: 'kind sources is reserved for the sources key',
      });
    }
  })
  .describe('A validated placeholder declaration and its render location.');

/** Inferred TypeScript representation of {@link TemplateSlot}. */
export type TemplateSlot = z.infer<typeof TemplateSlot>;

/** Pure parsed representation of one Markdown report template. */
export const TemplateManifest = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .nullable()
      .describe('Normalized template name, or null when frontmatter omits it.'),
    description: z.string().nullable().describe('One-line author description, or null.'),
    guidance: z
      .string()
      .min(1)
      .nullable()
      .describe('Optional document-level author guidance appended to the model schema, or null.'),
    tags: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .describe('Normalized, deduplicated, sorted template tags.'),
    slots: z.array(TemplateSlot).min(1).describe('Slots in declaration order.'),
    body: z.string().describe('Markdown below YAML frontmatter, retained verbatim.'),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of the complete raw template text.'),
  })
  .strict()
  .describe('Validated slot manifest produced from a report template.');

/** Inferred TypeScript representation of {@link TemplateManifest}. */
export type TemplateManifest = z.infer<typeof TemplateManifest>;

/** A scalar, list, or table value supplied for a template slot. */
export const TemplateSlotValue = z.union([
  z.string(),
  z.array(z.string()),
  z.array(z.array(z.string())),
]);

/** Inferred TypeScript representation of {@link TemplateSlotValue}. */
export type TemplateSlotValue = z.infer<typeof TemplateSlotValue>;

/** Provenance identifying the template revision used for a rendered report. */
export const ReportTemplateReference = z
  .object({
    name: z.string().nullable(),
    source: z.enum(['saved', 'path']),
    path: z.string().nullable(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .describe('Template identity and content hash recorded with a rendered report.');

/** Persisted templated report written as `document.json`. */
export const TemplatedReport = z
  .object({
    report_id: z.string().regex(ULID_PATTERN).describe('Unique report document id (ULID).'),
    task_id: z.string().regex(ULID_PATTERN).describe('Originating task id (ULID).'),
    schema_version: z.literal(BRIEF_SCHEMA_VERSION),
    template: ReportTemplateReference,
    title: z.string().min(1).describe('Display title used by history and HTML.'),
    slots: z.record(TemplateSlotValue).describe('Validated model-filled slot values.'),
    rendered_md: z.string().describe('Canonical Markdown rendered by the runtime.'),
    sources: z.array(BriefSource).describe('Engine-owned evidence ledger sources.'),
    metadata: BriefMetadata.describe('Reused Brief provenance and usage metadata.'),
    notices: z.array(BriefNotice).describe('Reused Brief notices.'),
  })
  .strict()
  .describe('A runtime-rendered report backed by a user-authored Markdown template.');

/** Inferred TypeScript representation of {@link TemplatedReport}. */
export type TemplatedReport = z.infer<typeof TemplatedReport>;

/** One actionable issue returned when a templated report fails validation. */
export interface TemplatedReportValidationIssue {
  /** Path segments reported by Zod. */
  readonly path: readonly (string | number)[];
  /** Slash-joined representation of {@link path}. */
  readonly pointer: string;
  /** Human-readable failure message. */
  readonly message: string;
}

/** Result error carrying all templated-report schema violations. */
export class TemplatedReportValidationError extends Error {
  public override readonly name = 'TemplatedReportValidationError';
  public readonly code = 'templated_report_validation_error';

  /** Create an error from already-normalized validation issues. */
  public constructor(public readonly issues: readonly TemplatedReportValidationIssue[]) {
    super(
      `Templated report validation failed with ${issues.length} issue(s): ${issues
        .map((issue) => `${issue.pointer || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
}

/**
 * Validate untrusted input as a {@link TemplatedReport} without throwing.
 *
 * @param raw Candidate document read from a provider or artifact.
 * @returns The parsed report or a structured issue collection.
 */
export function validateTemplatedReport(
  raw: unknown,
): Result<TemplatedReport, TemplatedReportValidationError> {
  const parsed = TemplatedReport.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  return err(
    new TemplatedReportValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        pointer: issue.path.join('/'),
        message: issue.message,
      })),
    ),
  );
}
