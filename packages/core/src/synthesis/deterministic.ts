/**
 * DeterministicSynthesizer — the `--no-llm` contract and golden-test backbone.
 *
 * ## Composes evidence, does not scrape claims
 *
 * The synthesizer is now a thin **composer** over an {@link EvidenceSet}. All
 * the selection work — query profiling, source relevance gating, eligibility
 * gates, sentence-level support, near-duplicate merge, entity-anchored facets —
 * happens in `buildEvidenceSet` (see `evidence/evidence-set.ts`). This class
 * turns that already-selected evidence into a {@link Brief}:
 *
 * - **Key findings** are the top accepted claims, carrying their citations in
 *   the structured `citations[]` array only — no inline `[n]` in the text.
 * - **The overview** leads with a query-target definition when available,
 *   then uses TextRank + MMR to add central, non-redundant claims while
 *   keeping inline `[n]` markers (the renderers subtle-ize them).
 * - **Sections** hold the *remainder* of the accepted claims grouped by kind;
 *   a claim shown as a finding never repeats in a section.
 * - **Notices** are honest: per-source failures, one `source_excluded` per
 *   query-irrelevant source, and a `limited_evidence` notice when fewer
 *   relevant findings survived than the requested length asked for.
 * - **`metadata.evidence`** reports the candidate/accepted claim counts and the
 *   number of excluded sources; **coverage** is over the *included* sources.
 *
 * Determinism invariant (plan §2): same input always yields the same Brief
 * (modulo the generated `brief_id`), which is what makes the golden-Brief suite
 * possible. Time-derived fields (`freshness`) use an injectable clock.
 */

import type {
  BriefFacets,
  BriefNotice,
  ChildFinding,
  KeyFinding,
  Result,
  Section,
} from '@yantra/protocol';
import { createBrief, err, ok, validateBrief } from '@yantra/protocol';

import { BlockSegmentingAnalyzer } from './analysis/block-segmentation.js';
import type { TextAnalyzer } from './analysis/text-analyzer.js';
import { WinkAnalyzer } from './analysis/wink-analyzer.js';
import { validateCitations } from './citation-validator.js';
import { buildEvidenceSet, LENGTH_BUDGETS } from './evidence/evidence-set.js';
import { deriveKeyFigures } from './evidence/figures.js';
import { selectMmr, textRank } from './evidence/rank.js';
import {
  groupClaimsByTopic,
  MAX_CHILDREN_PER_FINDING,
  type TopicGroup,
} from './evidence/topic-groups.js';
import type { AcceptedFacets, EvidenceClaim } from './evidence/types.js';
import { SynthesisError } from './types.js';
import type {
  SourceFailure,
  SynthesisDoc,
  SynthesisInput,
  SynthesisLength,
  SynthesisOptions,
  SynthesisOutcome,
  Synthesizer,
} from './types.js';

/** How many top claims compose the answer-first overview. */
const OVERVIEW_CLAIMS = 3;

/** MMR relevance weight: favor strong claims while suppressing restatements. */
const FINDING_MMR_LAMBDA = 0.7;

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

/** A composed claim: display text plus its resolved citation numbers. */
interface ComposedClaim {
  readonly claim: EvidenceClaim;
  readonly text: string;
  readonly citations: readonly number[];
}

interface ComposedGroup {
  readonly parent: ComposedClaim;
  readonly children: readonly ComposedClaim[];
}

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
  /**
   * Linguistic analyzer backing sentence/entity analysis. Defaults to the
   * winkNLP-backed {@link WinkAnalyzer} (local, offline, deterministic); the
   * behavior-stable `BaselineAnalyzer` can be injected here as a network-free
   * fallback or for parity tests.
   */
  readonly analyzer?: TextAnalyzer;
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

  private readonly analyzer: TextAnalyzer;

  public constructor(deps: DeterministicSynthesizerDeps = {}) {
    this.clock = deps.clock ?? (() => new Date());
    this.analyzer = deps.analyzer ?? new BlockSegmentingAnalyzer(new WinkAnalyzer());
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
    const { evidenceSet, keptDocs, sources, clusterNumberByDoc, candidateClaims } =
      buildEvidenceSet(input, this.analyzer, opts.length);

    const budget = LENGTH_BUDGETS[opts.length];

    const groups = composeGroups(
      groupClaimsByTopic(evidenceSet.claims, this.analyzer),
      clusterNumberByDoc,
    );

    // Findings and sections partition the accepted claims — a finding never
    // repeats as a section bullet.
    const findingGroups = selectFindingGroups(groups, this.analyzer, budget);

    const keyFindings: KeyFinding[] = findingGroups.map((group) => ({
      text: group.parent.text,
      citations: [...group.parent.citations],
      editorial: false,
      facet: null,
      children: group.children.slice(0, MAX_CHILDREN_PER_FINDING).map(childFinding),
    }));

    const overview = composeOverview(findingGroups, input.query, this.analyzer);
    const sections =
      opts.detail === 'overview' ? [] : composeSections(groups, findingGroups, budget, opts.detail);
    const facets = toBriefFacets(evidenceSet.facets);

    const citedNumbers = new Set<number>();
    for (const group of findingGroups) {
      group.parent.citations.forEach((n) => citedNumbers.add(n));
      group.children
        .slice(0, MAX_CHILDREN_PER_FINDING)
        .forEach((child) => child.citations.forEach((n) => citedNumbers.add(n)));
    }
    for (const section of sections) {
      section.citations.forEach((n) => citedNumbers.add(n));
    }

    const notices: BriefNotice[] = [
      ...noticesFromFailures(input.failures),
      ...evidenceSet.exclusions.map((exclusion) => ({
        source: exclusion.host,
        reason: exclusion.reason,
        kind: 'source_excluded' as const,
      })),
    ];
    if (groups.length < budget && (groups.length > 0 || sources.length > 0)) {
      notices.push({
        source: 'synthesis',
        reason: limitedEvidenceReason(groups.length, budget, opts.length),
        kind: 'limited_evidence',
      });
    }

    const brief = createBrief({
      task_id: opts.taskId,
      title: composeTitle(input.query, keptDocs.map((doc) => doc.title).filter(isString)),
      overview,
      key_findings: keyFindings,
      sections,
      facets,
      sources,
      notices,
      metadata: {
        search_provider: opts.searchProvider,
        synthesis: 'deterministic',
        deterministic_fallback_used: false,
        coverage: sources.length === 0 ? null : citedNumbers.size / sources.length,
        freshness: classifyFreshness(keptDocs, this.clock()),
        usage: null,
        evidence: {
          candidate_claims: candidateClaims,
          accepted_claims: evidenceSet.claims.length,
          excluded_sources: evidenceSet.exclusions.length,
        },
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
function citationsFor(claim: EvidenceClaim, clusterNumberByDoc: readonly number[]): number[] {
  const numbers = new Set<number>();
  for (const docIndex of claim.docIndexes) {
    const n = clusterNumberByDoc[docIndex];
    if (n !== undefined && n >= 1) {
      numbers.add(n);
    }
  }
  return [...numbers].sort((left, right) => left - right);
}

function composeGroups(
  groups: readonly TopicGroup[],
  clusterNumberByDoc: readonly number[],
): readonly ComposedGroup[] {
  return groups
    .map((group) => ({
      parent: composeClaim(group.parent, clusterNumberByDoc),
      children: group.children
        .map((claim) => composeClaim(claim, clusterNumberByDoc))
        .filter((entry) => entry.text.length > 0 && entry.citations.length > 0),
    }))
    .filter((group) => group.parent.text.length > 0 && group.parent.citations.length > 0);
}

function composeClaim(claim: EvidenceClaim, clusterNumberByDoc: readonly number[]): ComposedClaim {
  return {
    claim,
    text: stripAnsi(claim.text).trim(),
    citations: citationsFor(claim, clusterNumberByDoc),
  };
}

function childFinding(entry: ComposedClaim): ChildFinding {
  return { text: entry.text, citations: [...entry.citations] };
}

/** Maps the internal accepted facets onto the protocol facet shape. */
function toBriefFacets(facets: AcceptedFacets | null): BriefFacets | null {
  if (facets === null) {
    return null;
  }
  return { comparison: { columns: [...facets.columns], rows: facets.rows.map((row) => [...row]) } };
}

function composeTitle(query: string, sourceTitles: readonly string[]): string {
  const cleaned = stripAnsi(query).replace(/\s+/gu, ' ').trim().slice(0, 120);
  if (cleaned.length === 0) {
    return 'Untitled brief';
  }
  const required = sourceTitles.length < 2 ? sourceTitles.length : 2;
  const recased = cleaned.replace(/\p{L}{2,}/gu, (token) => {
    const variants = new Map<string, number>();
    for (const title of sourceTitles) {
      const match = new RegExp(`\\b${escapeRegExp(token)}\\b`, 'iu').exec(title)?.[0];
      if (match !== undefined && match !== token) {
        variants.set(match, (variants.get(match) ?? 0) + 1);
      }
    }
    const winner = [...variants.entries()].sort(
      ([left, leftCount], [right, rightCount]) =>
        rightCount - leftCount || left.localeCompare(right),
    )[0];
    return winner !== undefined && winner[1] >= required && required > 0 ? winner[0] : token;
  });
  return recased.charAt(0).toUpperCase() + recased.slice(1);
}

/** Definitional lead plus central, mutually non-redundant selected findings. */
function composeOverview(
  groups: readonly ComposedGroup[],
  query: string,
  analyzer: TextAnalyzer,
): string {
  const candidates = groups.map((group) => group.parent);
  if (candidates.length === 0) {
    return 'No usable source content could be synthesized for this query.';
  }
  const queryTokens = new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const lead = candidates.find((entry) => isDefinitional(entry.claim, queryTokens));
  const remaining = candidates.filter(
    (entry) =>
      entry !== lead && (lead === undefined || analyzer.containment(lead.text, entry.text) < 0.85),
  );
  const centrality = textRank(
    remaining.map((entry) => entry.text),
    (left, right) => analyzer.similarity(left, right),
  );
  const centralityByClaim = new Map(
    remaining.map((entry, index) => [entry, centrality[index] ?? 0]),
  );
  const selected = selectMmr(
    remaining,
    (entry) => centralityByClaim.get(entry) ?? 0,
    (left, right) => analyzer.similarity(left.text, right.text),
    FINDING_MMR_LAMBDA,
    OVERVIEW_CLAIMS - (lead === undefined ? 0 : 1),
  );
  return [...(lead === undefined ? [] : [lead]), ...selected]
    .map((entry) => `${entry.text} ${entry.citations.map((n) => `[${n}]`).join('')}`)
    .join(' ');
}

function isDefinitional(claim: EvidenceClaim, queryTokens: ReadonlySet<string>): boolean {
  if (claim.kind !== 'fact' && claim.kind !== 'entity') return false;
  const firstTokens = claim.text.match(/[\p{L}\p{N}']+/gu)?.slice(0, 8) ?? [];
  if (!firstTokens.some((token) => /^(?:is|are|was|were)$/iu.test(token))) return false;
  return claim.entityKeys.some((key) => queryTokens.has(key));
}

function selectFindingGroups(
  groups: readonly ComposedGroup[],
  analyzer: TextAnalyzer,
  budget: number,
): readonly ComposedGroup[] {
  const ordered = [...groups].sort(
    (left, right) =>
      right.parent.claim.salience - left.parent.claim.salience ||
      (left.parent.claim.docIndexes[0] ?? Infinity) -
        (right.parent.claim.docIndexes[0] ?? Infinity) ||
      left.parent.text.localeCompare(right.parent.text),
  );
  return selectMmr(
    ordered,
    (group) => group.parent.claim.salience,
    (left, right) => analyzer.similarity(left.parent.text, right.parent.text),
    FINDING_MMR_LAMBDA,
    budget,
  );
}

/** Groups the remainder claims by kind into kind-headed detail sections. */
function composeSections(
  groups: readonly ComposedGroup[],
  findingGroups: readonly ComposedGroup[],
  budget: number,
  detail: 'standard' | 'full',
): Section[] {
  const pool = sectionPool(groups, findingGroups, budget, detail);

  const sections: Section[] = [];
  for (const [kind, heading] of SECTION_HEADINGS) {
    const parentCap = detail === 'full' ? 12 : 8;
    const sectionGroups = pool
      .filter((entry) => entry.parent.claim.kind === kind)
      .slice(0, parentCap);
    if (sectionGroups.length < 2) {
      continue;
    }

    const citations = new Set<number>();
    for (const group of sectionGroups) {
      group.parent.citations.forEach((n) => citations.add(n));
      group.children.forEach((child) => child.citations.forEach((n) => citations.add(n)));
    }

    let bodyMd = sectionGroups.map(sectionGroupMarkdown).join('\n');
    if (kind === 'number') {
      const figures = deriveKeyFigures(
        sectionGroups.map((group) => ({
          text: group.parent.text,
          citations: group.parent.citations,
        })),
      );
      if (figures.length >= 3) {
        const tableCap = detail === 'full' ? 12 : 8;
        const tableFigures = figures.slice(0, tableCap);
        const used = new Set(tableFigures.map((figure) => figure.sourceText));
        const bulletCap = detail === 'full' ? 10 : 6;
        const bullets = sectionGroups
          .filter((group) => !used.has(group.parent.text))
          .slice(0, bulletCap);
        bodyMd = [keyFiguresTable(tableFigures), ...bullets.map(sectionGroupMarkdown)].join('\n');
      } else {
        const bulletCap = detail === 'full' ? 10 : 6;
        bodyMd = sectionGroups.slice(0, bulletCap).map(sectionGroupMarkdown).join('\n');
      }
    }

    sections.push({
      heading,
      body_md: bodyMd,
      citations: [...citations].sort((left, right) => left - right),
    });
  }

  return sections;
}

function keyFiguresTable(figures: ReturnType<typeof deriveKeyFigures>): string {
  const rows = figures.map(
    (figure) =>
      `| ${escapeTableCell(figure.figure)} | ${escapeTableCell(figure.context)} | ${figure.citations.map((n) => `[${n}]`).join('')} |`,
  );
  return ['| Figure | Context | Sources |', '| --- | --- | --- |', ...rows].join('\n');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isString(value: string | null): value is string {
  return value !== null;
}

function sectionPool(
  groups: readonly ComposedGroup[],
  findingGroups: readonly ComposedGroup[],
  budget: number,
  detail: 'standard' | 'full',
): readonly ComposedGroup[] {
  const findingOverflow = findingGroups
    .map((group) => ({
      parent: group.parent,
      children: group.children.slice(MAX_CHILDREN_PER_FINDING),
    }))
    .filter((group) => group.children.length > 0);
  const selected = new Set(findingGroups);
  const nonFindingGroups = groups.filter((group) => !selected.has(group));
  const pool = [...findingOverflow, ...nonFindingGroups];
  return detail === 'full' ? pool : pool.slice(0, budget);
}

function sectionGroupMarkdown(group: ComposedGroup): string {
  const parent = `- ${group.parent.text} ${group.parent.citations.map((n) => `[${n}]`).join('')}`;
  const children = group.children.map(
    (child) => `  - ${child.text} ${child.citations.map((n) => `[${n}]`).join('')}`,
  );
  return [parent, ...children].join('\n');
}

/** Honest under-budget wording for the `limited_evidence` notice. */
function limitedEvidenceReason(accepted: number, budget: number, length: SynthesisLength): string {
  const findings = accepted === 1 ? '1 relevant finding' : `${accepted} relevant findings`;
  return `only ${findings} met the evidence bar for a ${length} brief (up to ${budget} requested)`;
}

/** Buckets the newest doc timestamp relative to `now` into a freshness label. */
function classifyFreshness(docs: readonly SynthesisDoc[], now: Date): string | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const doc of docs) {
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
