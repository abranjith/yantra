/**
 * Follow-up query generation (TASK-004).
 *
 * Between hops the loop must turn "what's still uncovered" into fresh search
 * queries. Two strategies, mirroring the synthesizer:
 *
 * - **Deterministic** — template expansion over the uncovered subtopic labels
 *   (`"<topic> <subtopic>"`, `"<subtopic> explained"`, plus comparative
 *   modifiers when the topic looks like a comparison). No LLM, no network.
 * - **LLM** — the sanitized interim overview + gap labels are handed to the
 *   injected {@link SynthesisLlm} port (via an agent-side prompt template)
 *   which proposes sharper queries. Model output is *untrusted input*: every
 *   returned query is validated (plain string, length/charset bounds) and any
 *   failure falls back to the deterministic path.
 *
 * Both paths are **novelty-filtered** against already-issued queries (a query
 * that merely restates a prior hop wastes budget) and **capped** at
 * {@link MAX_QUERIES_PER_HOP}.
 *
 * Security: the interim overview flows through the single `sanitize()`
 * chokepoint *before* it reaches `this.llm.send(...)` — enforced here and by
 * the CI static-analysis guard, exactly as in `LlmSynthesizer`.
 */

import type { Logger } from '../browser/types.js';
import { sanitize } from '../sanitizer/index.js';
import type { SanitizationProfile } from '../sanitizer/profiles.js';
import { tokenize } from '../synthesis/similarity.js';
import type { SynthesisLlm, SynthesisScope } from '../synthesis/types.js';

/** Hard cap on follow-up queries issued per hop (plan §2 constraint). */
export const MAX_QUERIES_PER_HOP = 3;

/** Min/max character bounds enforced on every generated query. */
const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CHARS = 120;

/** Jaccard similarity at/above which two queries are treated as duplicates. */
const NOVELTY_JACCARD_THRESHOLD = 0.8;

/** Control characters (incl. DEL) forbidden in a query — LLM output is untrusted. */
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

/** Topic cues that flip on comparative query modifiers. */
const COMPARATIVE_CUES: readonly string[] = [
  'vs',
  'versus',
  'compare',
  'comparison',
  'best',
  'cheapest',
  'price',
  'alternative',
  'alternatives',
];

/** Inputs the agent-side prompt builder receives (sanitized text only). */
export interface ResearchQueryPromptInput {
  /** The research topic. */
  readonly topic: string;
  /** Uncovered subtopic labels driving the follow-ups. */
  readonly gaps: readonly string[];
  /** Sanitized interim overview (already through the chokepoint). */
  readonly overview: string;
  /** Queries already issued (so the model avoids repeats). */
  readonly issued: readonly string[];
  /** Maximum queries to propose. */
  readonly max: number;
}

/**
 * Structural shape of the agent-side query-gen prompt. Declared core-side so
 * `core` never imports `agent`; `apps/cli` injects the concrete template
 * (`packages/agent/src/research/prompt.ts`) at wiring time.
 */
export interface ResearchQueryPromptTemplate {
  /** Static system prompt. */
  readonly system: string;
  /** Builds the user prompt from the topic, gaps, and sanitized overview. */
  buildUser(input: ResearchQueryPromptInput): string;
}

/** One query-generation request. */
export interface QueryGenInput {
  /** The research topic. */
  readonly topic: string;
  /** Uncovered subtopic labels (gap analysis output). */
  readonly gaps: readonly string[];
  /** Interim overview text used to sharpen LLM queries; UNSANITIZED in. */
  readonly interimOverview: string;
  /** Queries already issued across prior hops. */
  readonly issuedQueries: readonly string[];
  /** Contextual scope selecting the sanitizer profile for the LLM path. */
  readonly scope: SynthesisScope;
  /** Host attributed to the overview text for sanitizer logging. */
  readonly host: string;
}

/** The outcome of one generation. */
export interface QueryGenResult {
  /** Novel, validated, capped follow-up queries (may be empty). */
  readonly queries: readonly string[];
  /** True when the LLM port was actually invoked (loop records LLM budget). */
  readonly usedLlm: boolean;
}

/** Constructor dependencies. */
export interface FollowUpQueryGeneratorDeps {
  /** LLM port for the LLM path, or null to force deterministic-only. */
  readonly llm?: SynthesisLlm | null;
  /** Agent-side prompt template; required when `llm` is set. */
  readonly prompt?: ResearchQueryPromptTemplate | null;
  /** Optional logger. */
  readonly logger?: Logger;
}

/**
 * Generates novelty-filtered, capped follow-up queries via the LLM path when
 * available, falling back to deterministic template expansion otherwise.
 */
export class FollowUpQueryGenerator {
  private readonly llm: SynthesisLlm | null;
  private readonly prompt: ResearchQueryPromptTemplate | null;
  private readonly logger: Logger | null;

  public constructor(deps: FollowUpQueryGeneratorDeps = {}) {
    this.llm = deps.llm ?? null;
    this.prompt = deps.prompt ?? null;
    this.logger = deps.logger ?? null;
  }

  /**
   * Produces up to {@link MAX_QUERIES_PER_HOP} fresh queries for the next hop.
   *
   * @param input - Topic, gaps, interim overview, and issued queries.
   * @returns The novel queries plus whether the LLM path was used.
   */
  public async generate(input: QueryGenInput): Promise<QueryGenResult> {
    if (this.llm !== null && this.prompt !== null) {
      const llmResult = await this.generateWithLlm(input);
      if (llmResult !== null) {
        return { queries: llmResult, usedLlm: true };
      }
    }
    return { queries: this.deterministic(input), usedLlm: false };
  }

  /**
   * LLM path: sanitize the overview, prompt the model, then validate + filter
   * its output. Returns null on any failure so the caller falls back.
   */
  private async generateWithLlm(input: QueryGenInput): Promise<readonly string[] | null> {
    // Narrow the nullable fields up front so the send call below reads as the
    // literal `this.llm.send(...)` the sanitize-before-send static guard tracks
    // (a non-null assertion or local alias would slip past the guard).
    if (this.llm === null || this.prompt === null) {
      return null;
    }
    const profile: SanitizationProfile = input.scope;
    // Sanitize BEFORE send (single chokepoint) — kept as a direct statement so
    // the sanitize-before-send static guard sees it precede this.llm.send.
    const sanitized = sanitize(input.interimOverview, profile, input.host);
    const user = this.prompt.buildUser({
      topic: input.topic,
      gaps: input.gaps,
      overview: sanitized.text,
      issued: input.issuedQueries,
      max: MAX_QUERIES_PER_HOP,
    });

    const response = await this.llm.send({ system: this.prompt.system, user });
    if (!response.isOk) {
      this.logger?.warn(
        { reason: response.error.message },
        'research query-gen LLM failed; using deterministic fallback',
      );
      return null;
    }

    const candidates = parseQueries(response.value.text).map((raw) => normalizeQueryText(raw));
    const valid = candidates.filter(isValidQuery);
    if (valid.length === 0) {
      this.logger?.warn({}, 'research query-gen LLM returned no valid queries; falling back');
      return null;
    }

    const novel = filterNovel(valid, input.issuedQueries);
    // A model that only echoed prior queries is a real (empty) result, not a
    // failure — the loop will terminate on `no_novel_queries`.
    return novel.slice(0, MAX_QUERIES_PER_HOP);
  }

  /** Deterministic template expansion over the uncovered subtopics. */
  private deterministic(input: QueryGenInput): readonly string[] {
    const comparative = isComparative(input.topic);
    const generated: string[] = [];

    for (const gap of input.gaps) {
      const subtopic = normalizeQueryText(gap);
      if (subtopic.length === 0) {
        continue;
      }
      generated.push(`${input.topic} ${subtopic}`);
      generated.push(`${subtopic} explained`);
      if (comparative) {
        generated.push(`${subtopic} comparison`);
      }
    }

    const valid = generated.map(normalizeQueryText).filter(isValidQuery);
    const novel = filterNovel(dedupeQueries(valid), input.issuedQueries);
    return novel.slice(0, MAX_QUERIES_PER_HOP);
  }
}

/** Collapses whitespace and trims a candidate query. */
export function normalizeQueryText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** A query is valid when it is a plain, bounded, control-char-free string. */
export function isValidQuery(query: string): boolean {
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
    return false;
  }
  if (CONTROL_CHARS.test(query)) {
    return false;
  }
  // Must contain at least one informative (non-stopword) token.
  return tokenize(query).length > 0;
}

/** Removes near-duplicate queries against the issued set (token Jaccard). */
export function filterNovel(candidates: readonly string[], issued: readonly string[]): string[] {
  const issuedTokenSets = issued.map((query) => new Set(tokenize(query)));
  const kept: string[] = [];
  const keptTokenSets: Set<string>[] = [];

  for (const candidate of candidates) {
    const tokens = new Set(tokenize(candidate));
    const dupOfIssued = issuedTokenSets.some(
      (set) => jaccard(tokens, set) >= NOVELTY_JACCARD_THRESHOLD,
    );
    const dupOfKept = keptTokenSets.some(
      (set) => jaccard(tokens, set) >= NOVELTY_JACCARD_THRESHOLD,
    );
    if (dupOfIssued || dupOfKept) {
      continue;
    }
    kept.push(candidate);
    keptTokenSets.push(tokens);
  }
  return kept;
}

/** Case-insensitive exact dedupe preserving first occurrence. */
function dedupeQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const key = query.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(query);
    }
  }
  return out;
}

/** Jaccard similarity between two token sets (0 when both empty). */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** True when the topic reads like a comparison (enables comparative modifiers). */
function isComparative(topic: string): boolean {
  const tokens = new Set(tokenize(topic));
  return COMPARATIVE_CUES.some((cue) => tokens.has(cue));
}

/**
 * Parses a model reply into candidate query strings. Accepts a JSON array of
 * strings first; otherwise splits on newlines and strips list markers.
 */
export function parseQueries(responseText: string): string[] {
  const trimmed = responseText.trim();

  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === 'string');
      }
    } catch {
      // fall through to line parsing
    }
  }

  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '').replace(/^["']|["']$/gu, ''))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
