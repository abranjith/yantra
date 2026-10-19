/**
 * Brief — the universal synthesized output document (Yantra v2).
 *
 * Every user-facing surface (`ask`, `research`, `run` results, `do`)
 * converges on this one schema: an answer-first `overview`, scannable
 * `key_findings`, deep `sections`, structured `facets`, numbered
 * deduplicated `sources`, honest `notices`, and run `metadata`.
 * See `.spec-lite/plan_v2.md` §1 for the product rationale.
 *
 * Structural guarantee enforced here: **no uncited claims**. Every
 * `citations[]` entry must resolve to a declared `sources[].n`, and a
 * key finding without citations is only legal when explicitly marked
 * `editorial`. Payloads must also be clean for `--json`/`brief.md`
 * consumers: no raw ANSI escape bytes anywhere in the document text.
 */

import { z } from 'zod';

import { ULID_PATTERN } from '../utils/ulid.js';

import { ActionId, BriefAction } from './action-evidence.js';
import { ScreenshotArtifactPath } from './artifact-ref.js';
import { ArtifactScope, CONTRACT_REQUIREMENT_ID_PATTERN, FillExemption } from './task-contract.js';

/**
 * Schema version Briefs are written under. Briefs are introduced by the
 * 0.2 protocol bump; older documents cannot exist, so this stays a strict
 * literal rather than the legacy-accepting version union used by `Plan`.
 */
export const BRIEF_SCHEMA_VERSION = '0.2' as const;

/** Matches the ESC (0x1B) and CSI (0x9B) bytes that start ANSI escape sequences. */
// eslint-disable-next-line no-control-regex -- matching raw ANSI escape bytes is the point of this refinement
const ANSI_ESCAPE_PATTERN = /[\u001b\u009b]/;

const ANSI_MESSAGE = 'must not contain raw ANSI escape bytes (\\u001b or \\u009b)';

const noAnsi = (value: string): boolean => !ANSI_ESCAPE_PATTERN.test(value);

const CitationList = z
  .array(z.number().int().min(1).describe('A source number (sources[].n).'))
  .describe('Source numbers (sources[].n) backing this content.');
const ActionList = z.array(ActionId).max(8).describe('Recorded action IDs backing this content.');

const FacetScalar = z
  .union([z.string(), z.number(), z.boolean(), z.null()])
  .describe('A scalar facet value.');

export const ChildFinding = z
  .object({
    text: z
      .string()
      .min(1)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Markdown text of a nested child finding.'),
    citations: CitationList.min(1).describe(
      'Source numbers (sources[].n) backing this child finding; at least one is required.',
    ),
  })
  .describe('A one-level nested finding under a key finding.');

export type ChildFinding = z.infer<typeof ChildFinding>;

export const KeyFinding = z
  .object({
    actions: ActionList.optional(),
    text: z
      .string()
      .min(1)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe(
        'Markdown text of the finding. Inline [n] markers are optional: the LLM path may emit them, while the deterministic path carries citations only in the structured citations[] array. The structured array is the single source of truth for rendering.',
      ),
    citations: CitationList.describe(
      'Source numbers (sources[].n) backing this finding. At least one is required unless editorial is true.',
    ),
    editorial: z
      .boolean()
      .default(false)
      .describe('True marks uncited synthesis commentary — the only legal uncited form.'),
    facet: z
      .record(FacetScalar)
      .nullable()
      .default(null)
      .describe(
        'Optional structured payload (for example { price: 328, in_stock: true }), or null.',
      ),
    children: z
      .array(ChildFinding)
      .default([])
      .describe('Nested child findings that elaborate this parent; one level deep only.'),
  })
  .describe('A scannable, citation-backed finding bullet.');

export type KeyFinding = z.infer<typeof KeyFinding>;

/**
 * True when the `editorial` mark distinguishes findings *within this list* —
 * that is, at least one finding is cited.
 *
 * The mark means "uncited commentary", which is only information when some
 * sibling finding is *not* commentary. An all-editorial document would show
 * the same badge on every bullet, adding no information. Agentic findings
 * carrying evidence references are non-editorial; plain commentary remains
 * editorial. Renderers call this to decide whether to show the
 * mark at all; the flag itself stays on the finding, where `brief.json`
 * consumers and the citation-integrity rule still read it.
 */
export function editorialMarkIsInformative(findings: readonly KeyFinding[]): boolean {
  return findings.some((finding) => !finding.editorial);
}

export const Section = z
  .object({
    actions: ActionList.optional(),
    kind: z
      .enum(['alternatives'])
      .optional()
      .describe('Labels off-contract alternatives; absent for ordinary sections.'),
    heading: z.string().min(1).describe('Section heading.'),
    body_md: z
      .string()
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Markdown body prose; must not contain raw ANSI escapes.'),
    citations: CitationList.describe('Source numbers (sources[].n) cited by this section.'),
  })
  .describe('A deep-detail prose section of the Brief.');

export type Section = z.infer<typeof Section>;

export const BriefFacets = z
  .object({
    comparison: z
      .object({
        columns: z.array(z.string()).min(1).describe('Column headers.'),
        row_actions: z
          .array(ActionList)
          .optional()
          .describe('Recorded action IDs backing each row, in row order.'),
        rows: z
          .array(z.array(FacetScalar).describe('One comparison row.'))
          .describe('Comparison rows; every row length must equal columns.length.'),
        row_citations: z
          .array(CitationList)
          .optional()
          .describe('Sources backing each row, in row order; length must equal rows.length.'),
      })
      .nullable()
      .describe('Tabular comparison data, or null when the query has no comparative shape.'),
  })
  .superRefine((facets, ctx) => {
    if (facets.comparison === null) {
      return;
    }

    const width = facets.comparison.columns.length;
    if (
      facets.comparison.row_actions !== undefined &&
      facets.comparison.row_actions.length !== facets.comparison.rows.length
    )
      ctx.addIssue({
        code: 'custom',
        path: ['comparison', 'row_actions'],
        message: 'row_actions length must equal rows.length',
      });
    if (
      facets.comparison.row_citations !== undefined &&
      facets.comparison.row_citations.length !== facets.comparison.rows.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comparison', 'row_citations'],
        message: 'row_citations length must equal rows.length',
      });
    }
    facets.comparison.rows.forEach((row, rowIndex) => {
      if (row.length !== width) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['comparison', 'rows', rowIndex],
          message: `row length ${row.length} must equal columns.length ${width}`,
        });
      }
    });
  })
  .describe('Structured/tabular facets of the Brief.');

export type BriefFacets = z.infer<typeof BriefFacets>;

export const BriefSource = z
  .object({
    cited: z
      .boolean()
      .optional()
      .describe(
        'True for evidence cited by the answer; false for consulted-only sources. All-or-none across sources.',
      ),
    n: z.number().int().min(1).describe('Citation number; contiguous 1..N in array order.'),
    url: z.string().url().describe('URL as fetched.'),
    final_url: z
      .string()
      .url()
      .nullable()
      .default(null)
      .describe('Post-redirect landing URL, or null when no redirect was observed.'),
    host: z.string().min(1).describe('Source host.'),
    title: z.string().nullable().describe('Page title, or null when unavailable.'),
    excerpt: z
      .string()
      .nullable()
      .default(null)
      .describe('Short extracted snippet of the source content, or null when not captured.'),
    fetched_at: z.string().datetime().describe('ISO-8601 UTC fetch timestamp.'),
    published_at: z
      .string()
      .datetime()
      .nullable()
      .describe('ISO-8601 publication timestamp, or null when unknown.'),
  })
  .describe('A numbered, deduplicated source reference.');

export type BriefSource = z.infer<typeof BriefSource>;

export const BriefConstraint = z
  .object({
    name: z
      .string()
      .min(1)
      .max(60)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Condition name from the task contract.'),
    value: z.string().min(1).max(120).refine(noAnsi, ANSI_MESSAGE).describe('Condition value.'),
    status: z
      .enum(['verified', 'unverified', 'violated'])
      .describe('Whether the condition is confirmed, unknown, or not met.'),
    citations: CitationList.default([]).describe(
      'Evidence backing the status; verified requires at least one source.',
    ),
  })
  .describe('A declared condition and its evidence-backed delivery status.');
export type BriefConstraint = z.infer<typeof BriefConstraint>;

/** Most per-item requirement statuses one Brief carries. */
export const BRIEF_MAX_REQUIREMENTS = 16;

/** Most fill exemptions one requirement lists before counting the rest. */
export const BRIEF_MAX_EXEMPTIONS = 20;

export const BriefRequirement = z
  .object({
    id: z
      .string()
      .regex(CONTRACT_REQUIREMENT_ID_PATTERN)
      .describe(
        'Requirement id: deliverable, filter:<name>, fill, artifact:screenshot:<scope>, or effects.submit.',
      ),
    label: z
      .string()
      .min(1)
      .max(120)
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Plain-words name of the requirement.'),
    status: z
      .enum(['met', 'unmet', 'not_applicable'])
      .describe('Whether evidence shows the requirement met, unmet, or not applicable.'),
    reason: z
      .string()
      .min(1)
      .max(200)
      .refine(noAnsi, ANSI_MESSAGE)
      .nullable()
      .describe('What the evidence showed, or null when nothing needs saying.'),
    declared_in: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('The contract revision that declared the requirement, or null when not tracked.'),
    exemptions: z
      .array(
        z
          .object({
            label: z.string().min(1).max(120).refine(noAnsi, ANSI_MESSAGE).describe('Field label.'),
            reason: FillExemption,
          })
          .describe('A form control the engine left out of "fill every eligible field".'),
      )
      .max(BRIEF_MAX_EXEMPTIONS)
      .optional()
      .describe('Controls the engine judged exempt from the fill requirement.'),
    exempt_overflow: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('How many more exempt controls exist beyond the listed ones.'),
  })
  .describe('One declared requirement of the task contract and its evidence-judged status.');

export type BriefRequirement = z.infer<typeof BriefRequirement>;

/** Most capture files one Brief links. */
export const BRIEF_MAX_ARTIFACTS = 12;

/** Most files one capture set holds. */
export const CAPTURE_MAX_PARTS = 6;

/**
 * Why a capture set is not a plain picture of what was asked: the page was
 * wider than a tile (`clipped_width`), taller than the set holds
 * (`truncated`), or the element sat outside the visible area
 * (`beyond_viewport`). The first two make the set incomplete.
 */
export const CaptureLabel = z
  .enum(['clipped_width', 'truncated', 'beyond_viewport'])
  .describe('A label on a capture set: clipped_width, truncated, or beyond_viewport.');

export type CaptureLabel = z.infer<typeof CaptureLabel>;

export const BriefArtifact = z
  .object({
    kind: z.literal('screenshot').describe('The artifact kind.'),
    scope: ArtifactScope,
    path: ScreenshotArtifactPath,
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .describe('Lowercase hex SHA-256 of the file bytes.'),
    bytes: z.number().int().nonnegative().describe('File size in bytes.'),
    width: z.number().int().positive().describe('Image width in pixels.'),
    height: z.number().int().positive().describe('Image height in pixels.'),
    part: z.number().int().min(1).describe('1-based position of this file in its capture set.'),
    parts: z
      .number()
      .int()
      .min(1)
      .max(CAPTURE_MAX_PARTS)
      .describe('How many files the capture set holds.'),
    complete: z
      .boolean()
      .describe('False when the set was clipped or truncated and does not show the whole target.'),
    labels: z.array(CaptureLabel).max(3).describe('Labels on the capture set.'),
  })
  .strict()
  .describe('One saved capture file the run produced, linked relative to the run directory.');

export type BriefArtifact = z.infer<typeof BriefArtifact>;

export const BriefMetadata = z
  .object({
    search_provider: z
      .string()
      .nullable()
      .describe('Search provider that produced the source candidates, or null.'),
    synthesis: z
      .enum(['deterministic', 'llm'])
      .describe('Synthesis strategy that produced the Brief.'),
    deterministic_fallback_used: z
      .boolean()
      .describe('True when the LLM path failed and the deterministic synthesizer took over.'),
    coverage: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe('Fraction of fetched sources represented in the Brief (0-1), or null.'),
    freshness: z
      .string()
      .nullable()
      .describe('Human-readable freshness signal (for example "today"), or null.'),
    citation_verdict: z
      .object({
        claims_checked: z
          .number()
          .int()
          .nonnegative()
          .describe('Claims inspected by the citation-faithfulness validator.'),
        flagged: z.number().int().nonnegative().describe('Claims flagged as unanchored.'),
        stripped: z.number().int().nonnegative().describe('Claims stripped as unanchored.'),
      })
      .nullable()
      .default(null)
      .describe(
        'Citation-faithfulness verdict (filled post-synthesis), or null before validation.',
      ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().describe('LLM input tokens consumed.'),
        output_tokens: z.number().int().nonnegative().describe('LLM output tokens produced.'),
        cost_usd: z.number().nonnegative().describe('Estimated LLM cost in USD.'),
      })
      .nullable()
      .describe('LLM usage totals, or null on the deterministic path.'),
    evidence: z
      .object({
        candidate_claims: z
          .number()
          .int()
          .nonnegative()
          .describe('Claim candidates considered before the eligibility gates.'),
        accepted_claims: z
          .number()
          .int()
          .nonnegative()
          .describe('Claims that passed the eligibility gates and reached the Brief.'),
        excluded_sources: z
          .number()
          .int()
          .nonnegative()
          .describe('Sources dropped by the query-relevance gate before assembly.'),
      })
      .nullable()
      .default(null)
      .describe(
        'Evidence-selection counts from the deterministic pipeline (candidate vs accepted claims, excluded sources), or null on the LLM path.',
      ),
    run_id: z.string().nullable().describe('Owning run id, or null outside a run context.'),
  })
  .describe('Provenance and quality metadata for the Brief.');

export type BriefMetadata = z.infer<typeof BriefMetadata>;

export const BriefNotice = z
  .object({
    source: z.string().describe('Host or subsystem the notice concerns.'),
    reason: z.string().min(1).describe('Human-readable reason for the notice.'),
    kind: z
      .enum([
        'fetch_failed',
        'extract_failed',
        'blocked',
        'source_excluded',
        'uncited_claim_stripped',
        'uncited_claim_flagged',
        'budget_exhausted',
        'limited_evidence',
        'search_failed',
        'contract_gap',
        'other',
      ])
      .describe(
        'Notice classification. `contract_gap` marks a part of the declared task contract not delivered, a condition not confirmed or not met, or rows shown as alternatives because they do not come from a required source. `source_excluded` marks a source dropped as irrelevant to the query before assembly; `limited_evidence` marks a Brief that fell short of the requested length because too few relevant findings survived the evidence gates; `search_failed` marks web searches that failed during the run, grouped by stable failure code (source `search:<provider>`); `budget_exhausted` marks a run budget (navigations, hosts) that Yantra itself imposed running out, never a site refusing access.',
      ),
  })
  .describe('An honest per-source failure or validator flag.');

export type BriefNotice = z.infer<typeof BriefNotice>;

export const Brief = z
  .object({
    actions: z
      .array(BriefAction)
      .max(40)
      .optional()
      .describe('Cited action evidence, in first-citation order; absent on older Briefs.'),
    brief_id: z.string().regex(ULID_PATTERN).describe('Unique Brief document id (ULID).'),
    task_id: z.string().regex(ULID_PATTERN).describe('Originating task id (ULID).'),
    schema_version: z
      .literal(BRIEF_SCHEMA_VERSION)
      .describe('Protocol schema version this document was written under.'),
    title: z.string().min(1).describe('One-line document title.'),
    overview: z
      .string()
      .refine(noAnsi, ANSI_MESSAGE)
      .describe('Answer-first Markdown synthesis (1-3 paragraphs) with inline [n] citations.'),
    key_findings: z.array(KeyFinding).describe('Scannable findings; may be empty.'),
    sections: z
      .array(Section)
      .describe('Deep-detail sections; empty at the overview synthesis budget.'),
    facets: BriefFacets.nullable().describe(
      'Structured/tabular facets, or null when the query has no comparative shape.',
    ),
    sources: z.array(BriefSource).describe('Numbered, deduplicated source references.'),
    constraints: z
      .array(BriefConstraint)
      .max(24)
      .optional()
      .describe('Declared conditions and their delivery statuses; absent on older artifacts.'),
    requirements: z
      .array(BriefRequirement)
      .max(BRIEF_MAX_REQUIREMENTS)
      .optional()
      .describe(
        'Each declared requirement of a do task and its evidence-judged status; absent on older artifacts and on ask and research Briefs.',
      ),
    artifacts: z
      .array(BriefArtifact)
      .max(BRIEF_MAX_ARTIFACTS)
      .optional()
      .describe(
        'Saved capture files of a do task, one entry per file in capture order; absent on older artifacts and on ask and research Briefs.',
      ),
    metadata: BriefMetadata.describe('Provenance and quality signals.'),
    notices: z
      .array(BriefNotice)
      .describe('Honest per-source failures and validator flags; may be empty.'),
  })
  .superRefine((brief, ctx) => {
    const actionIds = new Set<string>();
    brief.actions?.forEach((action, index) => {
      if (actionIds.has(action.id))
        ctx.addIssue({
          code: 'custom',
          path: ['actions', index, 'id'],
          message: 'Action IDs must be unique',
        });
      actionIds.add(action.id);
    });
    const checkActions = (ids: readonly string[] | undefined, path: (string | number)[]): void => {
      ids?.forEach((id, index) => {
        if (!actionIds.has(id))
          ctx.addIssue({
            code: 'custom',
            path: [...path, index],
            message: `${id} does not resolve to declared action evidence`,
          });
      });
    };
    brief.key_findings.forEach((finding, index) =>
      checkActions(finding.actions, ['key_findings', index, 'actions']),
    );
    brief.sections.forEach((section, index) =>
      checkActions(section.actions, ['sections', index, 'actions']),
    );
    brief.facets?.comparison?.row_actions?.forEach((ids, index) =>
      checkActions(ids, ['facets', 'comparison', 'row_actions', index]),
    );
    // sources[].n must be strictly ascending and contiguous from 1.
    brief.sources.forEach((source, index) => {
      if (source.n !== index + 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'n'],
          message: `sources[].n must be contiguous from 1 in array order; expected ${index + 1}, received ${source.n}`,
        });
      }
    });

    // No duplicate normalized URLs (normalized = final_url ?? url).
    const seenUrls = new Map<string, number>();
    brief.sources.forEach((source, index) => {
      const normalized = source.final_url ?? source.url;
      const firstIndex = seenUrls.get(normalized);
      if (firstIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, source.final_url !== null ? 'final_url' : 'url'],
          message: `duplicate normalized source URL; already declared by sources[${firstIndex}]`,
        });
        return;
      }
      seenUrls.set(normalized, index);
    });

    // Referential integrity: every citation must resolve to a declared source.
    const declared = new Set(brief.sources.map((source) => source.n));
    const consulted = new Set(
      brief.sources.filter((source) => source.cited === false).map((source) => source.n),
    );
    const classified = brief.sources.some((source) => source.cited !== undefined);
    let seenConsulted = false;
    brief.sources.forEach((source, index) => {
      if (classified && source.cited === undefined)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'cited'],
          message: 'cited must be defined for all sources or none',
        });
      if (seenConsulted && source.cited === true)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sources', index, 'cited'],
          message: 'cited sources must precede consulted-only sources',
        });
      if (source.cited === false) seenConsulted = true;
    });
    const checkCitations = (citations: readonly number[], basePath: (string | number)[]): void => {
      citations.forEach((citation, citationIndex) => {
        if (!declared.has(citation) || consulted.has(citation)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...basePath, 'citations', citationIndex],
            message: consulted.has(citation)
              ? `citation [${citation}] references a consulted-only source`
              : `citation [${citation}] does not resolve to a declared sources[].n`,
          });
        }
      });
    };

    brief.key_findings.forEach((finding, index) => {
      checkCitations(finding.citations, ['key_findings', index]);
      finding.children.forEach((child, childIndex) => {
        checkCitations(child.citations, ['key_findings', index, 'children', childIndex]);
      });
      if (
        !finding.editorial &&
        finding.citations.length === 0 &&
        (finding.actions?.length ?? 0) === 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['key_findings', index, 'citations'],
          message:
            'non-editorial findings must cite at least one source (set editorial: true for uncited commentary)',
        });
      }
    });

    brief.sections.forEach((section, index) => {
      checkCitations(section.citations, ['sections', index]);
    });
    brief.facets?.comparison?.row_citations?.forEach((citations, index) => {
      citations.forEach((citation, j) => {
        if (!declared.has(citation) || consulted.has(citation))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['facets', 'comparison', 'row_citations', index, j],
            message: 'row citation must resolve to a cited source',
          });
      });
    });
    brief.constraints?.forEach((constraint, index) => {
      checkCitations(constraint.citations, ['constraints', index]);
      if (constraint.status === 'verified' && constraint.citations.length === 0)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['constraints', index, 'citations'],
          message: 'verified constraints must cite at least one source',
        });
    });
    const requirementIds = new Set<string>();
    brief.requirements?.forEach((requirement, index) => {
      if (requirementIds.has(requirement.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requirements', index, 'id'],
          message: 'requirement ids must be unique within a Brief',
        });
      requirementIds.add(requirement.id);
    });
    const artifactPaths = new Set<string>();
    brief.artifacts?.forEach((artifact, index) => {
      if (artifactPaths.has(artifact.path))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index, 'path'],
          message: 'artifact paths must be unique within a Brief',
        });
      artifactPaths.add(artifact.path);
      if (artifact.part > artifact.parts)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts', index, 'part'],
          message: `part ${artifact.part} exceeds parts ${artifact.parts}`,
        });
    });
  })
  .describe(
    'The universal synthesized output document: answer-first overview, key findings, sections, facets, numbered sources, notices, and metadata. Every citation resolves to a declared source (no uncited claims).',
  );

export type Brief = z.infer<typeof Brief>;
