import { z } from 'zod';

/**
 * `contract.json` (FEAT-052): what an agentic `research`/`do` run declared the
 * user's goal requires — the deliverable, the fields each row or answer
 * needs, every stated filter, and any site the goal names. FEAT-054 adds the
 * action terms a `do` run needs: `deliverable: 'actions'`, `fill` coverage,
 * requested `artifacts`, and declared `effects`. They default to neutral
 * values, so a contract written before them parses unchanged.
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

/** Most field names a `fill.coverage: 'listed'` term may name. */
export const CONTRACT_FILL_MAX_FIELDS = 40;

/** Most artifacts one contract may request. */
export const CONTRACT_MAX_ARTIFACTS = 3;

const FieldName = z.string().min(1).max(60);

/**
 * Why the engine judged a form control exempt from `fill.coverage:
 * 'all_eligible'`. A closed set the engine classifies from DOM state; the
 * model never declares an exemption. Protected-type fields (passwords,
 * sensitive `autocomplete` tokens) are eligible and never appear here.
 */
export const FillExemption = z
  .enum(['disabled', 'read_only', 'hidden', 'file_input', 'human_verification'])
  .describe('Why the engine left a form control out of "fill every eligible field".');

export type FillExemption = z.infer<typeof FillExemption>;

/** The capture scopes a screenshot artifact may request. */
export const ArtifactScope = z
  .enum(['viewport', 'full_page', 'element'])
  .describe('What a screenshot covers: the visible viewport, the full page, or one element.');

export type ArtifactScope = z.infer<typeof ArtifactScope>;

/**
 * Stable ids of the requirements a contract declares, shared by the runtime
 * evaluation, `contract.json` `requirements`, and the Brief's `requirements`:
 * `deliverable`, `filter:<normalized name>`, `fill`,
 * `artifact:screenshot:<scope>`, and `effects.submit`.
 */
export const CONTRACT_REQUIREMENT_ID_PATTERN =
  /^(?:deliverable|fill|effects\.submit|artifact:screenshot:(?:viewport|full_page|element)|filter:\S(?:.{0,58}\S)?)$/;

/** The id of a screenshot artifact requirement for `scope`. */
export function artifactRequirementId(scope: ArtifactScope): string {
  return `artifact:screenshot:${scope}`;
}

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

const ContractFill = z
  .object({
    coverage: z
      .enum(['all_eligible', 'listed'])
      .describe(
        'Fill every field the engine judges eligible on the form, or only the listed fields.',
      ),
    fields: z
      .array(FieldName)
      .max(CONTRACT_FILL_MAX_FIELDS)
      .optional()
      .describe(
        'The field names to fill; required (1-40, unique case-insensitively) for listed, forbidden for all_eligible.',
      ),
  })
  .describe('Which form fields the goal asks to fill.');

const ContractArtifact = z
  .object({
    kind: z.literal('screenshot').describe('The artifact kind.'),
    scope: ArtifactScope,
  })
  .describe('One artifact the goal asks the run to produce.');

const ContractEffects = z
  .object({
    submit: z
      .enum(['forbidden', 'allowed'])
      .describe('Whether the run may submit a form; forbidden makes the engine refuse it.'),
  })
  .describe('Side effects the goal permits or forbids.');

export const TaskContractBody = z
  .object({
    deliverable: z
      .enum(['table', 'answer', 'report', 'actions'])
      .describe(
        'What the run delivers: rows of fields, a direct answer, a prose report, or page actions (state changed or captured) with a Brief of what was done.',
      ),
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
        'Normalized hostnames of sites the goal names (lowercase; no scheme, path, port, or leading www.). Unique. For an actions deliverable, the host the actions must happen on.',
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
    fill: ContractFill.nullable()
      .default(null)
      .describe('Which form fields the goal asks to fill, or null when it asks for none.'),
    artifacts: z
      .array(ContractArtifact)
      .max(CONTRACT_MAX_ARTIFACTS)
      .default([])
      .describe('Artifacts the goal asks for, such as a screenshot; unique by kind and scope.'),
    effects: ContractEffects.default({ submit: 'allowed' }).describe(
      'Side effects the goal permits; submit defaults to allowed.',
    ),
  })
  .superRefine((body, ctx) => {
    if (body.fill !== null) {
      const fields = body.fill.fields;
      if (body.fill.coverage === 'listed' && (fields === undefined || fields.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fill', 'fields'],
          message: 'a listed fill must name at least one field.',
        });
      }
      if (body.fill.coverage === 'all_eligible' && fields !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fill', 'fields'],
          message: 'an all_eligible fill must not list fields.',
        });
      }
      if (fields !== undefined && hasCaseInsensitiveDuplicate(fields)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fill', 'fields'],
          message: 'fill fields must be unique case-insensitively.',
        });
      }
    }
    const artifactKeys = body.artifacts.map((artifact) => `${artifact.kind}:${artifact.scope}`);
    if (new Set(artifactKeys).size !== artifactKeys.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'artifacts must be unique by kind and scope.',
      });
    }
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

/** A contract body before defaults apply: the action terms may be absent. */
export type TaskContractBodyInput = z.input<typeof TaskContractBody>;

/** Most action requirements a record lists (one fill, three artifacts, one effect). */
const MAX_RECORDED_REQUIREMENTS = 1 + CONTRACT_MAX_ARTIFACTS + 1;

export const ContractRequirementOrigin = z
  .object({
    id: z
      .string()
      .regex(CONTRACT_REQUIREMENT_ID_PATTERN)
      .describe('The requirement id, such as fill or artifact:screenshot:viewport.'),
    declared_in: z
      .number()
      .int()
      .min(1)
      .describe('The revision that first declared this requirement.'),
  })
  .describe('An action requirement still in force and the revision that declared it.');

export type ContractRequirementOrigin = z.infer<typeof ContractRequirementOrigin>;

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
    requirements: z
      .array(ContractRequirementOrigin)
      .max(MAX_RECORDED_REQUIREMENTS)
      .optional()
      .describe(
        'Action requirements (fill, artifacts, effects) in force across every revision, each with the revision that declared it. A later revision cannot drop one. Absent on older files.',
      ),
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
    const ids = new Set<string>();
    record.requirements?.forEach((requirement, index) => {
      if (ids.has(requirement.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirements', index, 'id'],
          message: 'requirement ids must be unique.',
        });
      }
      ids.add(requirement.id);
      if (requirement.declared_in > record.revisions.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirements', index, 'declared_in'],
          message: 'declared_in must name an existing revision.',
        });
      }
    });
  })
  .describe(
    'The task contract an agentic research/do run declared (contract.json): every revision in declaration order, the last being current. Sanitized, model-authored, and never a source of authority.',
  );

export type TaskContractRecord = z.infer<typeof TaskContractRecord>;
