/**
 * Builder and validation helpers for the {@link Brief} document.
 *
 * Producers (the synthesis pipeline, FEAT-014) assemble Briefs through
 * `createBrief`, extend them immutably with `appendNotice`, and gate every
 * document that crosses a trust boundary through `validateBrief` — which
 * returns a `Result` and never throws, carrying zod issue paths suitable
 * for the bounded re-prompt loop on the LLM synthesis path.
 */

import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import { generateUlid } from '../utils/ulid.js';

import type {
  BriefFacets,
  BriefMetadata,
  BriefNotice,
  BriefSource,
  KeyFinding,
  Section,
} from './brief.js';
import { BRIEF_SCHEMA_VERSION, Brief } from './brief.js';

/**
 * Input accepted by {@link createBrief}. Only the identity and answer
 * fields are mandatory; everything else defaults to the empty/null shape
 * of a minimal deterministic Brief.
 */
export interface CreateBriefInput {
  /** Originating task id (ULID). */
  readonly task_id: string;
  /** One-line document title. */
  readonly title: string;
  /** Answer-first Markdown synthesis with inline [n] citations. */
  readonly overview: string;
  /** Scannable findings; defaults to []. */
  readonly key_findings?: readonly KeyFinding[];
  /** Deep-detail sections; defaults to []. */
  readonly sections?: readonly Section[];
  /** Structured/tabular facets; defaults to null. */
  readonly facets?: BriefFacets | null;
  /** Numbered, deduplicated sources; defaults to []. */
  readonly sources?: readonly BriefSource[];
  /** Metadata overrides merged over the deterministic defaults. */
  readonly metadata?: Partial<BriefMetadata>;
  /** Honest per-source failures; defaults to []. */
  readonly notices?: readonly BriefNotice[];
}

const DEFAULT_METADATA: BriefMetadata = {
  search_provider: null,
  synthesis: 'deterministic',
  deterministic_fallback_used: false,
  coverage: null,
  freshness: null,
  citation_verdict: null,
  usage: null,
  evidence: null,
  run_id: null,
};

/**
 * Assembles a new {@link Brief} with a freshly generated ULID `brief_id`,
 * the current `schema_version`, and defaulted empty arrays/null facets.
 *
 * The builder does not validate citation integrity — run the result
 * through {@link validateBrief} before persisting or emitting it.
 *
 * @param input - Identity and content fields; see {@link CreateBriefInput}.
 * @returns A fully-populated Brief document (new object, caller-owned).
 *
 * @example
 * const brief = createBrief({
 *   task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
 *   title: 'Cheapest Sony WH-1000XM5 today',
 *   overview: 'Lowest price is $328 at Amazon. [1]',
 *   sources: [source],
 *   key_findings: [
 *     {
 *       text: 'Amazon — $328 [1]',
 *       citations: [1],
 *       editorial: false,
 *       facet: null,
 *       children: [{ text: 'Amazon lists free shipping.', citations: [1] }],
 *     },
 *   ],
 * });
 */
export const createBrief = (input: CreateBriefInput): Brief => ({
  brief_id: generateUlid(),
  task_id: input.task_id,
  schema_version: BRIEF_SCHEMA_VERSION,
  title: input.title,
  overview: input.overview,
  key_findings: [...(input.key_findings ?? [])],
  sections: [...(input.sections ?? [])],
  facets: input.facets ?? null,
  sources: [...(input.sources ?? [])],
  metadata: { ...DEFAULT_METADATA, ...input.metadata },
  notices: [...(input.notices ?? [])],
});

/**
 * Returns a new Brief with `notice` appended to `notices`.
 *
 * The input Brief is not mutated — producers can hold references to
 * earlier snapshots safely.
 *
 * @param brief - The Brief to extend.
 * @param notice - The notice to append.
 * @returns A new Brief instance; `brief` is left untouched.
 *
 * @example
 * const withNotice = appendNotice(brief, {
 *   source: 'example.com',
 *   reason: 'fetch timed out',
 *   kind: 'fetch_failed',
 * });
 */
export const appendNotice = (brief: Brief, notice: BriefNotice): Brief => ({
  ...brief,
  notices: [...brief.notices, notice],
});

/** A single actionable validation issue extracted from a zod failure. */
export interface BriefValidationIssue {
  /** Path segments to the offending value (for example ['key_findings', 0, 'citations', 1]). */
  readonly path: readonly (string | number)[];
  /** Slash-joined rendering of `path` (for example 'key_findings/0/citations/1'). */
  readonly pointer: string;
  /** Human-readable failure message. */
  readonly message: string;
}

/**
 * Raised (as a `Result` error, never thrown) when a candidate document
 * fails Brief validation. Carries every zod issue path so LLM-path callers
 * can build a structured re-prompt (max-2-retries convention).
 */
export class BriefValidationError extends Error {
  public readonly code = 'brief_validation_error';

  public constructor(public readonly issues: readonly BriefValidationIssue[]) {
    super(
      `Brief validation failed with ${issues.length} issue(s): ${issues
        .map((issue) => `${issue.pointer === '' ? '(root)' : issue.pointer}: ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'BriefValidationError';
  }
}

/**
 * Validates an untrusted candidate document against the {@link Brief} schema.
 *
 * Never throws: schema failures — including all citation-integrity
 * refinements — are returned as an `err` carrying actionable issue paths.
 *
 * @param raw - Any value, typically parsed JSON from disk or an LLM response.
 * @returns `ok(brief)` with the parsed (defaults applied) document, or
 *   `err(BriefValidationError)` listing every violation.
 *
 * @example
 * const result = validateBrief(JSON.parse(rawJson));
 * if (!result.isOk) {
 *   result.error.issues.forEach((issue) => log.warn(issue.pointer, issue.message));
 * }
 */
export const validateBrief = (raw: unknown): Result<Brief, BriefValidationError> => {
  const parsed = Brief.safeParse(raw);
  if (parsed.success) {
    return ok(parsed.data);
  }

  return err(
    new BriefValidationError(
      parsed.error.issues.map((issue) => ({
        path: issue.path,
        pointer: issue.path.join('/'),
        message: issue.message,
      })),
    ),
  );
};
