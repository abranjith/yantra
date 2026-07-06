/**
 * CoverageTracker — the research loop's heuristic map of "what have we
 * actually answered?" (TASK-003).
 *
 * After hop 1 the tracker **seeds** a set of subtopics from the interim
 * synthesis (its section headings) plus the high-salience named entities that
 * recur across the fetched documents. Each subsequent hop **updates** which
 * subtopics are now evidenced by the pooled corpus. A subtopic counts as
 * *covered* once at least {@link MIN_EVIDENCE_DOCS} pooled documents evidence
 * it; the uncovered ones are the **gaps** that drive the next hop's queries.
 *
 * Honesty caveat (plan §2): coverage is a *heuristic signal*, not a guarantee.
 * It is surfaced in `Brief.metadata.coverage` so the reader can weigh how
 * completely the topic was mapped — never presented as proof of completeness.
 */

import type { Brief } from '@yantra/protocol';

import { tokenize } from '../synthesis/similarity.js';
import type { SynthesisDoc } from '../synthesis/types.js';

/** Documents that must evidence a subtopic before it is marked covered. */
export const MIN_EVIDENCE_DOCS = 2;

/** Fraction of a subtopic's informative tokens a doc must contain to evidence it. */
const EVIDENCE_TOKEN_THRESHOLD = 1;

/** Cap on entity-derived subtopics seeded from the corpus. */
const MAX_ENTITY_SUBTOPICS = 8;

/** Multi-word capitalized sequences treated as named-entity subtopic seeds. */
const ENTITY_PATTERN = /\b\p{Lu}[\p{Ll}\p{N}]+(?:\s+\p{Lu}[\p{Ll}\p{N}]+)+\b/gu;

/** One tracked subtopic and its coverage state. */
interface Subtopic {
  /** Human-readable label (section heading or entity phrase). */
  readonly label: string;
  /** Informative tokens a doc must contain to evidence this subtopic. */
  readonly tokens: readonly string[];
  /** Salience weight (higher = more central to the topic). */
  weight: number;
  /** Whether ≥ {@link MIN_EVIDENCE_DOCS} pooled docs evidence it. */
  covered: boolean;
  /** Pool doc indexes that evidence it (post-update). */
  evidenceDocIdx: number[];
}

/** A read-only view of a subtopic for state persistence + synthesis hints. */
export interface SubtopicView {
  readonly label: string;
  readonly weight: number;
  readonly covered: boolean;
}

/**
 * Tracks topic coverage across research hops. Seed once (from hop 1), update
 * every subsequent hop, then read `score()`/`gaps()` to drive termination and
 * follow-up queries.
 */
export class CoverageTracker {
  private readonly subtopics: Subtopic[] = [];
  private readonly seenLabels = new Set<string>();
  private seeded = false;

  /** True once {@link seed} has run. */
  public isSeeded(): boolean {
    return this.seeded;
  }

  /**
   * Seeds subtopics from the hop-1 interim Brief and the fetched corpus, then
   * immediately runs a coverage {@link update} over `docs`.
   *
   * Section headings become subtopics (weight ≥ 1). High-salience entities —
   * multi-word capitalized phrases recurring across ≥2 docs — are added,
   * highest cross-doc frequency first. When the Brief has no sections the
   * tracker degrades to entity-only seeding.
   *
   * @param brief - The hop-1 interim synthesis output.
   * @param docs - The pooled documents after hop 1.
   */
  public seed(brief: Brief, docs: readonly SynthesisDoc[]): void {
    for (const section of brief.sections) {
      this.addSubtopic(section.heading, Math.max(1, section.citations.length));
    }

    for (const { entity, docCount } of topEntities(docs)) {
      this.addSubtopic(entity, docCount);
    }

    this.seeded = true;
    this.update(docs);
  }

  /**
   * Recomputes coverage over the current pooled corpus: a subtopic is covered
   * once ≥ {@link MIN_EVIDENCE_DOCS} docs evidence it (contain its tokens).
   *
   * @param docs - The current pooled documents (rank order).
   */
  public update(docs: readonly SynthesisDoc[]): void {
    const docTokenSets = docs.map((doc) => new Set(tokenize(doc.text)));
    for (const subtopic of this.subtopics) {
      const evidence: number[] = [];
      docTokenSets.forEach((tokens, index) => {
        if (evidences(subtopic.tokens, tokens)) {
          evidence.push(index);
        }
      });
      subtopic.evidenceDocIdx = evidence;
      subtopic.covered = evidence.length >= MIN_EVIDENCE_DOCS;
    }
  }

  /**
   * Coverage score in [0, 1]: covered subtopic weight over total weight.
   * Returns 0 when nothing has been seeded (no corpus to judge coverage over).
   */
  public score(): number {
    let total = 0;
    let covered = 0;
    for (const subtopic of this.subtopics) {
      total += subtopic.weight;
      if (subtopic.covered) {
        covered += subtopic.weight;
      }
    }
    return total === 0 ? 0 : covered / total;
  }

  /**
   * Uncovered subtopic labels, highest weight first — the gaps that the next
   * hop's queries should target.
   *
   * @returns Uncovered labels in descending salience order.
   */
  public gaps(): string[] {
    return this.subtopics
      .filter((subtopic) => !subtopic.covered)
      .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
      .map((subtopic) => subtopic.label);
  }

  /** All subtopics (covered and not), highest weight first — for hints/state. */
  public views(): SubtopicView[] {
    return this.subtopics
      .slice()
      .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
      .map((subtopic) => ({
        label: subtopic.label,
        weight: subtopic.weight,
        covered: subtopic.covered,
      }));
  }

  /** Adds a subtopic, merging weight when a case-insensitive label repeats. */
  private addSubtopic(rawLabel: string, weight: number): void {
    const label = rawLabel.replace(/\s+/gu, ' ').trim();
    const tokens = tokenize(label);
    if (label.length === 0 || tokens.length === 0) {
      return;
    }
    const key = label.toLowerCase();
    if (this.seenLabels.has(key)) {
      const existing = this.subtopics.find((subtopic) => subtopic.label.toLowerCase() === key);
      if (existing) {
        existing.weight += weight;
      }
      return;
    }
    this.seenLabels.add(key);
    this.subtopics.push({ label, tokens, weight, covered: false, evidenceDocIdx: [] });
  }
}

/** A doc evidences a subtopic when it contains its informative tokens. */
function evidences(subtopicTokens: readonly string[], docTokens: ReadonlySet<string>): boolean {
  if (subtopicTokens.length === 0) {
    return false;
  }
  const hits = subtopicTokens.reduce((acc, token) => (docTokens.has(token) ? acc + 1 : acc), 0);
  return hits / subtopicTokens.length >= EVIDENCE_TOKEN_THRESHOLD;
}

/**
 * Top named entities across the doc set (multi-word capitalized phrases that
 * recur in ≥2 documents), highest cross-doc frequency first.
 */
function topEntities(docs: readonly SynthesisDoc[]): { entity: string; docCount: number }[] {
  const docsByEntity = new Map<string, Set<number>>();
  docs.forEach((doc, index) => {
    for (const match of doc.text.matchAll(ENTITY_PATTERN)) {
      const entity = match[0];
      const holder = docsByEntity.get(entity) ?? new Set<number>();
      holder.add(index);
      docsByEntity.set(entity, holder);
    }
  });

  return [...docsByEntity.entries()]
    .filter(([, holders]) => holders.size >= 2)
    .map(([entity, holders]) => ({ entity, docCount: holders.size }))
    .sort((a, b) => b.docCount - a.docCount || a.entity.localeCompare(b.entity))
    .slice(0, MAX_ENTITY_SUBTOPICS);
}
