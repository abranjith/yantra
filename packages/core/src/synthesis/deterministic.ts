/**
 * DeterministicSynthesizer — the `--no-llm` contract and golden-test backbone.
 *
 * Assembles a full {@link Brief} from the doc set with no LLM and no
 * network: near-duplicate clustering → claim extraction → salience ranking
 * → answer-first overview, budgeted key findings, kind-grouped sections,
 * comparison facets, and honest notices. Citations are faithful by
 * construction: every finding's `citations` derive from the doc indexes
 * that evidenced its claim.
 *
 * Determinism invariant (plan §2): same input always yields the same Brief
 * (modulo the generated `brief_id`), which is what makes the golden-Brief
 * suite in `e2e/golden-briefs/` possible. Time-derived fields (`freshness`)
 * use an injectable clock.
 */

import type { BriefNotice, KeyFinding, Result, Section } from '@yantra/protocol';
import { createBrief, err, ok, validateBrief } from '@yantra/protocol';

import { validateCitations } from './citation-validator.js';
import { extractClaims } from './claims.js';
import { clusterSources } from './clustering.js';
import { buildComparisonFacet } from './facets.js';
import { SynthesisError } from './types.js';
import type {
  ExtractedClaim,
  SourceFailure,
  SynthesisInput,
  SynthesisLength,
  SynthesisOptions,
  SynthesisOutcome,
  Synthesizer,
} from './types.js';

/** Key-finding budget per requested length. */
const LENGTH_BUDGETS: Readonly<Record<SynthesisLength, number>> = {
  short: 3,
  medium: 6,
  long: 10,
};

/** How many top claims compose the answer-first overview. */
const OVERVIEW_CLAIMS = 3;

/** Section headings per claim kind, in emission order. */
const SECTION_HEADINGS = [
  ['number', 'Numbers & figures'],
  ['fact', 'Key facts'],
  ['entity', 'People & organizations'],
  ['quote', 'Notable quotes'],
] as const;

/** Brief text fields refuse raw ANSI escapes; strip them from web content. */
// eslint-disable-next-line no-control-regex -- removing raw ANSI escape bytes is the point
const stripAnsi = (text: string): string => text.replace(/[\u001b\u009b]/gu, '');

/** Maps per-source pipeline failures to honest Brief notices. */
export function noticesFromFailures(failures: readonly SourceFailure[]): BriefNotice[] {
  return failures.map((failure) => ({
    source: failure.host,
    reason: stripAnsi(failure.reason) || 'source failed',
    kind:
      failure.stage === 'fetch'
        ? ('fetch_failed' as const)
        : failure.stage === 'extract'
          ? ('extract_failed' as const)
          : ('blocked' as const),
  }));
}

/** Constructor dependencies (all injectable for tests/golden fixtures). */
export interface DeterministicSynthesizerDeps {
  /** Clock used for freshness classification; defaults to `new Date()`. */
  readonly clock?: () => Date;
}

/**
 * The deterministic synthesis strategy.
 *
 * This class is the `--no-llm` contract: it must produce a real, structured,
 * schema-valid Brief for any input without a model, and it is the fallback
 * target when the LLM path fails. All golden-Brief fixtures pin this
 * strategy's output byte-for-byte (modulo generated ids).
 */
export class DeterministicSynthesizer implements Synthesizer {
  public readonly strategy = 'deterministic' as const;

  private readonly clock: () => Date;

  public constructor(deps: DeterministicSynthesizerDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Assembles the Brief for `input` under the budgets in `opts`.
   *
   * @param input - Query, rank-ordered docs, and per-source failures.
   * @param opts - Detail/length budgets and provenance fields.
   * @returns `ok(outcome)` with a schema-valid Brief; `err(SynthesisError)`
   *   only when the assembled document unexpectedly fails validation.
   */
  public synthesize(
    input: SynthesisInput,
    opts: SynthesisOptions,
  ): Promise<Result<SynthesisOutcome, SynthesisError>> {
    const { clusters, sources, clusterNumberByDoc } = clusterSources(input.docs);
    const rankedClaims = extractClaims(input.docs, input.query);

    const cited = rankedClaims
      .map((claim) => ({
        claim,
        text: stripAnsi(claim.text).trim(),
        citations: citationsFor(claim, clusterNumberByDoc),
      }))
      .filter((entry) => entry.text.length > 0 && entry.citations.length > 0);

    const budget = LENGTH_BUDGETS[opts.length];
    const findingClaims = cited.slice(0, budget);

    const keyFindings: KeyFinding[] = findingClaims.map((entry) => ({
      text: entry.text,
      citations: entry.citations,
      editorial: false,
      facet: null,
    }));

    const overview = composeOverview(input.query, findingClaims.slice(0, OVERVIEW_CLAIMS));
    const sections = opts.detail === 'overview' ? [] : composeSections(cited, opts.detail, budget);
    const facets = buildComparisonFacet(input.docs, clusters, sources);

    const citedNumbers = new Set<number>();
    for (const entry of findingClaims) {
      entry.citations.forEach((n) => citedNumbers.add(n));
    }
    for (const section of sections) {
      section.citations.forEach((n) => citedNumbers.add(n));
    }

    const brief = createBrief({
      task_id: opts.taskId,
      title: composeTitle(input.query),
      overview,
      key_findings: keyFindings,
      sections,
      facets,
      sources,
      notices: noticesFromFailures(input.failures),
      metadata: {
        search_provider: opts.searchProvider,
        synthesis: 'deterministic',
        deterministic_fallback_used: false,
        coverage: sources.length === 0 ? null : citedNumbers.size / sources.length,
        freshness: classifyFreshness(input, this.clock()),
        usage: null,
        run_id: opts.runId,
      },
    });

    const validated = validateBrief(brief);
    if (!validated.isOk) {
      return Promise.resolve(
        err(
          new SynthesisError(
            `deterministic synthesis produced an invalid Brief: ${validated.error.message}`,
            { query: input.query, strategy: 'deterministic', cause: validated.error },
          ),
        ),
      );
    }

    // Citation-faithfulness post-pass. Deterministic Briefs carry their
    // evidence by construction, so anchoring is skipped and the verdict is
    // always zero flags/strips — the pass still stamps metadata.citation_verdict.
    const { brief: annotated, verdict } = validateCitations(validated.value, input, {
      strategy: 'deterministic',
    });

    return Promise.resolve(
      ok({
        brief: annotated,
        verdict,
        strategyUsed: 'deterministic',
        fallbackUsed: false,
      }),
    );
  }
}

/** Unique, ascending source numbers evidencing a claim. */
function citationsFor(claim: ExtractedClaim, clusterNumberByDoc: readonly number[]): number[] {
  const numbers = new Set<number>();
  for (const docIndex of claim.docIndexes) {
    const n = clusterNumberByDoc[docIndex];
    if (n !== undefined && n >= 1) {
      numbers.add(n);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function composeTitle(query: string): string {
  const cleaned = stripAnsi(query).replace(/\s+/gu, ' ').trim().slice(0, 120);
  if (cleaned.length === 0) {
    return 'Untitled brief';
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Answer-first prose: top claims joined, each tailed by its [n] markers. */
function composeOverview(
  query: string,
  top: readonly { text: string; citations: readonly number[] }[],
): string {
  if (top.length === 0) {
    return 'No usable source content could be synthesized for this query.';
  }

  return top
    .map((entry) => `${entry.text} ${entry.citations.map((n) => `[${n}]`).join('')}`)
    .join(' ');
}

function composeSections(
  cited: readonly { claim: ExtractedClaim; text: string; citations: readonly number[] }[],
  detail: 'standard' | 'full',
  budget: number,
): Section[] {
  // Standard detail doubles the finding budget for depth; full keeps all.
  const pool = detail === 'full' ? cited : cited.slice(0, budget * 2);

  const sections: Section[] = [];
  for (const [kind, heading] of SECTION_HEADINGS) {
    const group = pool.filter((entry) => entry.claim.kind === kind);
    if (group.length === 0) {
      continue;
    }

    const citations = new Set<number>();
    for (const entry of group) {
      entry.citations.forEach((n) => citations.add(n));
    }

    sections.push({
      heading,
      body_md: group
        .map((entry) => `- ${entry.text} ${entry.citations.map((n) => `[${n}]`).join('')}`)
        .join('\n'),
      citations: [...citations].sort((left, right) => left - right),
    });
  }

  return sections;
}

/** Buckets the newest doc timestamp relative to `now` into a freshness label. */
function classifyFreshness(input: SynthesisInput, now: Date): string | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const doc of input.docs) {
    const stamp = Date.parse(doc.publishedAt ?? doc.fetchedAt);
    if (!Number.isNaN(stamp)) {
      newest = Math.max(newest, stamp);
    }
  }

  if (!Number.isFinite(newest)) {
    return null;
  }

  const ageMs = Math.max(0, now.getTime() - newest);
  const day = 24 * 60 * 60 * 1000;
  if (ageMs < day) {
    return 'today';
  }
  if (ageMs < 7 * day) {
    return 'this week';
  }
  if (ageMs < 31 * day) {
    return 'this month';
  }
  return 'older than a month';
}
