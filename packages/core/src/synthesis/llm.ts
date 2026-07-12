/**
 * LlmSynthesizer — the default strategy for `public`-scope content.
 *
 * Flow (sanitize → prompt → validate → fallback):
 *
 * 1. **Sanitize** — every doc's text passes through the single sanitizer
 *    chokepoint `sanitize(text, profileFor(scope), host)` *before* it reaches
 *    the prompt. This is enforced both by this code path and by the CI
 *    static-analysis guard (`scripts/ci-static-check.ts`), which requires a
 *    `sanitize()` call to precede every `this.llm.send(...)` in scope.
 * 2. **Prompt** — the injected {@link SynthesisPromptTemplate} (agent-side
 *    text, passed as data so `core` never imports `agent`) assembles the
 *    system/user messages from the sanitized numbered sources.
 * 3. **Validate** — the model returns JSON with the Brief's content fields;
 *    it is assembled via `createBrief` (sources + metadata are engine-owned,
 *    never model-owned) and checked with `validateBrief`. On failure the
 *    model is re-prompted with the serialized zod issue paths, bounded to
 *    {@link DEFAULT_MAX_REPROMPTS} retries (memory §Error Handling).
 * 4. **Fallback** — on unavailability, a provider error, malformed output
 *    that never validates, or a re-prompt budget exhaustion, the injected
 *    {@link DeterministicSynthesizer} takes over and
 *    `metadata.deterministic_fallback_used` is set to `true`. The LLM path is
 *    never a dead end (the agent-optional invariant).
 *
 * The citation-faithfulness validator runs as the final post-pass at `llm`
 * strictness (anchoring on), so fabricated numbers are stripped and weakly
 * anchored claims are flagged before the Brief is returned.
 */

import type { Brief, BriefFacets, KeyFinding, Result, Section } from '@yantra/protocol';
import { createBrief, err, ok, validateBrief } from '@yantra/protocol';

import type { Logger } from '../browser/types.js';
import { sanitize } from '../sanitizer/index.js';
import type { SanitizationProfile } from '../sanitizer/profiles.js';

import { validateCitations } from './citation-validator.js';
import { clusterSources } from './clustering.js';
import { SynthesisError } from './types.js';
import type {
  SynthesisInput,
  SynthesisLlm,
  SynthesisLlmUsage,
  SynthesisOptions,
  SynthesisOutcome,
  SynthesisPromptSource,
  SynthesisPromptTemplate,
  Synthesizer,
} from './types.js';

/** Bounded re-prompt budget on Brief-validation failure (memory convention). */
export const DEFAULT_MAX_REPROMPTS = 2;

/** Constructor dependencies for {@link LlmSynthesizer}. */
export interface LlmSynthesizerDeps {
  /** The injected LLM port (adapted from `LLMClient` by `apps/cli`). */
  readonly llm: SynthesisLlm;
  /** The prompt template (agent-side text, injected as data). */
  readonly prompt: SynthesisPromptTemplate;
  /** The deterministic strategy used as the fallback target. */
  readonly deterministic: Synthesizer;
  /** Re-prompt budget; defaults to {@link DEFAULT_MAX_REPROMPTS}. */
  readonly maxReprompts?: number;
  /** Optional logger; sanitized-payload details only at debug. */
  readonly logger?: Logger;
}

/** The model-authored content fields of a Brief (the engine owns the rest). */
interface LlmBriefDraft {
  readonly title: string;
  readonly overview: string;
  readonly key_findings: readonly KeyFinding[];
  readonly sections: readonly Section[];
  readonly facets: BriefFacets | null;
}

/** Maps a synthesis scope to its sanitizer profile (identical value space). */
function profileFor(scope: SynthesisOptions['scope']): SanitizationProfile {
  return scope;
}

/**
 * The LLM synthesis strategy. See the module doc for the full
 * sanitize → prompt → validate → fallback flow.
 */
export class LlmSynthesizer implements Synthesizer {
  public readonly strategy = 'llm' as const;

  private readonly llm: SynthesisLlm;
  private readonly prompt: SynthesisPromptTemplate;
  private readonly deterministic: Synthesizer;
  private readonly maxReprompts: number;
  private readonly logger: Logger | null;

  public constructor(deps: LlmSynthesizerDeps) {
    this.llm = deps.llm;
    this.prompt = deps.prompt;
    this.deterministic = deps.deterministic;
    this.maxReprompts = deps.maxReprompts ?? DEFAULT_MAX_REPROMPTS;
    this.logger = deps.logger ?? null;
  }

  /**
   * Synthesizes a Brief via the LLM, degrading to the deterministic strategy
   * on any failure.
   *
   * @param input - Query, ranked docs, and per-source failures.
   * @param opts - Strategy/detail/length budgets, scope, and provenance.
   * @returns The synthesis outcome; never a raw throw.
   */
  public async synthesize(
    input: SynthesisInput,
    opts: SynthesisOptions,
  ): Promise<Result<SynthesisOutcome, SynthesisError>> {
    const { sources, clusterNumberByDoc } = clusterSources(input.docs);

    // --- Sanitize every doc BEFORE prompt assembly (single chokepoint).
    // Sanitize is invoked as a direct statement here (not inside a nested
    // callback) so the sanitize-before-send static guard can see it precede
    // this.llm.send(...) below.
    const profile = profileFor(opts.scope);
    const promptSourceByNumber = new Map<number, SynthesisPromptSource>();
    for (let index = 0; index < input.docs.length; index += 1) {
      const doc = input.docs[index]!;
      const n = clusterNumberByDoc[index];
      if (n === undefined || n < 1) {
        continue;
      }
      const sanitized = sanitize(doc.text, profile, doc.host);
      const existing = promptSourceByNumber.get(n);
      promptSourceByNumber.set(
        n,
        existing === undefined
          ? { n, host: doc.host, title: doc.title, text: sanitized.text }
          : { ...existing, text: `${existing.text}\n${sanitized.text}` },
      );
    }
    const promptSources = [...promptSourceByNumber.values()].sort(
      (left, right) => left.n - right.n,
    );

    // --- Bounded send / re-prompt loop.
    let userPrompt = this.prompt.buildUser({
      query: input.query,
      sources: promptSources,
      detail: opts.detail,
      length: opts.length,
      ...(opts.hints && opts.hints.length > 0 ? { hints: opts.hints } : {}),
      ...(opts.personalization && opts.personalization.length > 0
        ? { personalization: opts.personalization }
        : {}),
    });
    let lastReason = 'llm synthesis did not converge';

    for (let attempt = 0; attempt <= this.maxReprompts; attempt += 1) {
      const response = await this.llm.send({ system: this.prompt.system, user: userPrompt });

      if (!response.isOk) {
        // Unavailability and provider errors are not fixable by re-prompt.
        return this.fallback(input, opts, response.error.message);
      }

      const draft = parseDraft(response.value.text);
      if (!draft.isOk) {
        lastReason = draft.error;
        userPrompt = this.prompt.buildReprompt([{ pointer: '(root)', message: draft.error }]);
        continue;
      }

      const candidate = assembleBrief(draft.value, sources, opts, response.value.usage);
      const validated = validateBrief(candidate);
      if (!validated.isOk) {
        lastReason = validated.error.message;
        userPrompt = this.prompt.buildReprompt(
          validated.error.issues.map((issue) => ({
            pointer: issue.pointer,
            message: issue.message,
          })),
        );
        continue;
      }

      // Citation-faithfulness post-pass at LLM strictness (anchoring on).
      const { brief: annotated, verdict } = validateCitations(validated.value, input, {
        strategy: 'llm',
      });
      const revalidated = validateBrief(annotated);
      if (!revalidated.isOk) {
        // Stripping should never invalidate; treat as a hard failure → fallback.
        return this.fallback(input, opts, revalidated.error.message);
      }

      this.logger?.debug({ verdict }, 'llm synthesis citation verdict');
      return ok({
        brief: revalidated.value,
        verdict,
        strategyUsed: 'llm',
        fallbackUsed: false,
      });
    }

    return this.fallback(input, opts, lastReason);
  }

  /** Runs the deterministic strategy and flags the fallback in metadata. */
  private async fallback(
    input: SynthesisInput,
    opts: SynthesisOptions,
    reason: string,
  ): Promise<Result<SynthesisOutcome, SynthesisError>> {
    this.logger?.warn({ reason }, 'llm synthesis fell back to deterministic strategy');

    const result = await this.deterministic.synthesize(input, opts);
    if (!result.isOk) {
      return err(
        new SynthesisError(`llm fallback to deterministic failed: ${result.error.message}`, {
          query: input.query,
          strategy: 'llm',
          cause: result.error,
        }),
      );
    }

    const brief: Brief = {
      ...result.value.brief,
      metadata: { ...result.value.brief.metadata, deterministic_fallback_used: true },
    };

    return ok({
      brief,
      verdict: result.value.verdict,
      strategyUsed: 'deterministic',
      fallbackUsed: true,
    });
  }
}

/**
 * Assembles the engine-owned Brief from the model's content draft. Sources
 * and metadata come from the engine (clustering + provenance), never the
 * model — the model can only influence prose and citation choices.
 */
function assembleBrief(
  draft: LlmBriefDraft,
  sources: ReturnType<typeof clusterSources>['sources'],
  opts: SynthesisOptions,
  usage: SynthesisLlmUsage | null,
): Brief {
  return createBrief({
    task_id: opts.taskId,
    title: draft.title,
    overview: draft.overview,
    key_findings: draft.key_findings,
    sections: draft.sections,
    facets: draft.facets,
    sources,
    metadata: {
      search_provider: opts.searchProvider,
      synthesis: 'llm',
      deterministic_fallback_used: false,
      coverage: sources.length === 0 ? null : coverageOf(draft, sources.length),
      freshness: null,
      usage:
        usage === null
          ? null
          : {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cost_usd: usage.costUsd,
            },
      run_id: opts.runId,
    },
  });
}

/** Fraction of declared sources the model actually cited. */
function coverageOf(draft: LlmBriefDraft, sourceCount: number): number {
  const cited = new Set<number>();
  for (const finding of draft.key_findings) {
    for (const n of finding.citations) {
      cited.add(n);
    }
  }
  for (const section of draft.sections) {
    for (const n of section.citations) {
      cited.add(n);
    }
  }
  return cited.size / sourceCount;
}

/**
 * Parses the model's response into an {@link LlmBriefDraft}. Tolerates code
 * fences and leading/trailing prose by extracting the first balanced JSON
 * object. Returns an error string suitable for a re-prompt on failure.
 */
export function parseDraft(responseText: string): Result<LlmBriefDraft, string> {
  const jsonText = extractJsonObject(responseText);
  if (jsonText === null) {
    return err('response did not contain a JSON object');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return err(
      `response was not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return err('response JSON was not an object');
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.title !== 'string' || typeof record.overview !== 'string') {
    return err('response JSON is missing required string fields "title" and "overview"');
  }

  return ok({
    title: record.title,
    overview: record.overview,
    key_findings: normalizeFindings(record.key_findings),
    sections: normalizeSections(record.sections),
    facets: normalizeFacets(record.facets),
  });
}

/** Extracts the first balanced `{...}` object from arbitrary model text. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Coerces the model's `key_findings` into schema-shaped values. Malformed
 * entries are dropped defensively; the engine's `validateBrief` is still the
 * authority (it will re-prompt on anything that survives but is invalid).
 */
function normalizeFindings(value: unknown): KeyFinding[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const findings: KeyFinding[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.text !== 'string') {
      continue;
    }
    findings.push({
      text: record.text,
      citations: numberArray(record.citations),
      editorial: record.editorial === true,
      facet: isFacetRecord(record.facet) ? (record.facet as KeyFinding['facet']) : null,
      children: [],
    });
  }
  return findings;
}

function normalizeSections(value: unknown): Section[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const sections: Section[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.heading !== 'string' || typeof record.body_md !== 'string') {
      continue;
    }
    sections.push({
      heading: record.heading,
      body_md: record.body_md,
      citations: numberArray(record.citations),
    });
  }
  return sections;
}

function normalizeFacets(value: unknown): BriefFacets | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const comparison = record.comparison;
  if (typeof comparison !== 'object' || comparison === null) {
    return { comparison: null };
  }
  const comparisonRecord = comparison as Record<string, unknown>;
  if (!Array.isArray(comparisonRecord.columns) || !Array.isArray(comparisonRecord.rows)) {
    return { comparison: null };
  }
  return {
    comparison: {
      columns: comparisonRecord.columns.filter(
        (column): column is string => typeof column === 'string',
      ),
      rows: comparisonRecord.rows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) => row.map(coerceScalar)),
    },
  };
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is number => typeof entry === 'number' && Number.isInteger(entry),
  );
}

function isFacetRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceScalar(value: unknown): string | number | boolean | null {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  // Non-scalar cell (object/array) — serialize deterministically rather than
  // risk '[object Object]'. The Brief schema only permits scalar facet cells.
  return JSON.stringify(value);
}
