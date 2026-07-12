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

export const Section = z
  .object({
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
        rows: z
          .array(z.array(FacetScalar).describe('One comparison row.'))
          .describe('Comparison rows; every row length must equal columns.length.'),
      })
      .nullable()
      .describe('Tabular comparison data, or null when the query has no comparative shape.'),
  })
  .superRefine((facets, ctx) => {
    if (facets.comparison === null) {
      return;
    }

    const width = facets.comparison.columns.length;
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
    fetched_at: z.string().datetime().describe('ISO-8601 UTC fetch timestamp.'),
    published_at: z
      .string()
      .datetime()
      .nullable()
      .describe('ISO-8601 publication timestamp, or null when unknown.'),
  })
  .describe('A numbered, deduplicated source reference.');

export type BriefSource = z.infer<typeof BriefSource>;

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
        'other',
      ])
      .describe(
        'Notice classification. `source_excluded` marks a source dropped as irrelevant to the query before assembly; `limited_evidence` marks a Brief that fell short of the requested length because too few relevant findings survived the evidence gates.',
      ),
  })
  .describe('An honest per-source failure or validator flag.');

export type BriefNotice = z.infer<typeof BriefNotice>;

export const Brief = z
  .object({
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
    metadata: BriefMetadata.describe('Provenance and quality signals.'),
    notices: z
      .array(BriefNotice)
      .describe('Honest per-source failures and validator flags; may be empty.'),
  })
  .superRefine((brief, ctx) => {
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
    const checkCitations = (citations: readonly number[], basePath: (string | number)[]): void => {
      citations.forEach((citation, citationIndex) => {
        if (!declared.has(citation)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...basePath, 'citations', citationIndex],
            message: `citation [${citation}] does not resolve to a declared sources[].n`,
          });
        }
      });
    };

    brief.key_findings.forEach((finding, index) => {
      checkCitations(finding.citations, ['key_findings', index]);
      finding.children.forEach((child, childIndex) => {
        checkCitations(child.citations, ['key_findings', index, 'children', childIndex]);
      });
      if (!finding.editorial && finding.citations.length === 0) {
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
  })
  .describe(
    'The universal synthesized output document: answer-first overview, key findings, sections, facets, numbered sources, notices, and metadata. Every citation resolves to a declared source (no uncited claims).',
  );

export type Brief = z.infer<typeof Brief>;
