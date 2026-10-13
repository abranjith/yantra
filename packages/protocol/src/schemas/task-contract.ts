import { z } from 'zod';

/**
 * `contract.json` (FEAT-052): what an agentic `research`/`do` run declared the
 * user's goal requires — the deliverable, the fields each row or answer
 * needs, every stated filter, and any site the goal names.
 *
 * The contract is model-authored. It is sanitized and normalized before it is
 * persisted, and it grants nothing: no URL provenance, allowlist, or budget is
 * ever derived from it. The artifact is optional for every reader: runs that
 * never declared a contract, `ask` runs, and runs written before it existed
 * have no file.
 */

export const TASK_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Most revisions one run may declare (the first plus two corrections). */
export const TASK_CONTRACT_MAX_REVISIONS = 3;

/** A normalized hostname: lowercase, no scheme, path, port, trailing dot, or leading `www.`. */
export const SOURCE_HOST_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const FieldName = z.string().min(1).max(60);

/** True when `values` has a case-insensitive duplicate. */
function hasCaseInsensitiveDuplicate(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export const TaskContractBody = z
  .object({
    deliverable: z
      .enum(['table', 'answer', 'report'])
      .describe('What the run delivers: rows of fields, a direct answer, or a prose report.'),
    subject: z.string().min(1).max(200).describe('What the rows or the answer are about.'),
    required_fields: z
      .array(FieldName)
      .max(12)
      .describe(
        'Fields each row or answer must carry, unique case-insensitively. Non-empty for a table.',
      ),
    filters: z
      .array(
        z
          .object({
            name: FieldName.describe('The condition the results must meet, such as "condition".'),
            value: z.string().min(1).max(120).describe('The required value, such as "new".'),
          })
          .describe('One condition the goal states.'),
      )
      .max(12)
      .describe('Every condition the goal states, with names unique case-insensitively.'),
    required_sources: z
      .array(z.string().regex(SOURCE_HOST_PATTERN).max(253))
      .max(5)
      .describe(
        'Normalized hostnames of sites the goal names (lowercase; no scheme, path, port, or leading www.). Unique.',
      ),
    ranking: z
      .object({
        field: FieldName.describe('The field results are ordered by.'),
        direction: z.enum(['asc', 'desc']).describe('Ascending or descending order.'),
      })
      .nullable()
      .describe('How results are ordered, when the goal asks for an order.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .nullable()
      .describe('How many results the goal asks for, when it says.'),
    notes: z
      .string()
      .max(500)
      .nullable()
      .describe('Anything the structure cannot express, such as a site named without its address.'),
  })
  .superRefine((body, ctx) => {
    if (hasCaseInsensitiveDuplicate(body.required_fields)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required_fields'],
        message: 'required_fields must be unique case-insensitively.',
      });
    }
    if (hasCaseInsensitiveDuplicate(body.filters.map((filter) => filter.name))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['filters'],
        message: 'filter names must be unique case-insensitively.',
      });
    }
    if (new Set(body.required_sources).size !== body.required_sources.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required_sources'],
        message: 'required_sources must be unique.',
      });
    }
    if (body.deliverable === 'table' && body.required_fields.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required_fields'],
        message: 'a table contract must name at least one required field.',
      });
    }
    if (
      body.deliverable === 'table' &&
      body.ranking !== null &&
      !body.required_fields.some(
        (field) => field.toLowerCase() === body.ranking?.field.toLowerCase(),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ranking', 'field'],
        message: 'a table ranking must order by one of required_fields.',
      });
    }
  })
  .describe(
    "A normalized task contract: the deliverable, required fields, filters, and required sources a run declared for the user's goal.",
  );

export type TaskContractBody = z.infer<typeof TaskContractBody>;

export const TaskContractRecord = z
  .object({
    schema_version: z
      .literal(TASK_CONTRACT_SCHEMA_VERSION)
      .describe('Task-contract schema version.'),
    run_id: z.string().min(1).describe('Owning run id.'),
    command: z.enum(['research', 'do']).describe('The agentic command that declared the contract.'),
    revisions: z
      .array(
        z
          .object({
            revision: z.number().int().min(1).describe('1-based revision number.'),
            declared_at: z.string().datetime().describe('ISO-8601 time the revision was declared.'),
            contract: TaskContractBody,
          })
          .describe('One declaration of the contract.'),
      )
      .min(1)
      .max(TASK_CONTRACT_MAX_REVISIONS)
      .describe('Declarations in order; the last one is the current contract.'),
  })
  .superRefine((record, ctx) => {
    record.revisions.forEach((entry, index) => {
      if (entry.revision !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revisions', index, 'revision'],
          message: `revision must be ${index + 1} at position ${index}.`,
        });
      }
    });
  })
  .describe(
    'The task contract an agentic research/do run declared (contract.json): every revision in declaration order, the last being current. Sanitized, model-authored, and never a source of authority.',
  );

export type TaskContractRecord = z.infer<typeof TaskContractRecord>;
