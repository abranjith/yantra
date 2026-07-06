/**
 * Research follow-up-query prompt template (agent-side).
 *
 * Like the synthesis prompt, the *text* lives here next to the other agent
 * prompts, but the `FollowUpQueryGenerator` that consumes it lives in
 * `packages/core` — and `core` cannot import `agent` (layering rule). So this
 * module exposes a plain-data template object matching the structural shape
 * `core` expects (`ResearchQueryPromptTemplate` in
 * `packages/core/src/research/query-gen.ts`); `apps/cli` passes it in at
 * wiring time.
 *
 * The template only assembles instructions plus the *already-sanitized*
 * interim overview and gap labels handed to it — it never touches raw fetched
 * content (the sanitizer chokepoint runs in `FollowUpQueryGenerator` before
 * this text is built).
 */

/** One numbered source block presented to the model. */
export interface ResearchQueryPromptInput {
  /** The research topic. */
  readonly topic: string;
  /** Uncovered subtopic labels driving the follow-ups. */
  readonly gaps: readonly string[];
  /** Sanitized interim overview text. */
  readonly overview: string;
  /** Queries already issued (so the model avoids repeats). */
  readonly issued: readonly string[];
  /** Maximum queries to propose. */
  readonly max: number;
}

/** Structural shape the core `FollowUpQueryGenerator` injects and calls. */
export interface ResearchQueryPromptTemplate {
  readonly system: string;
  buildUser(input: ResearchQueryPromptInput): string;
}

const SYSTEM_PROMPT = [
  "You are Yantra's research query planner. Given what a first pass has already",
  'found on a topic and which sub-questions remain unanswered, you propose the',
  'NEXT batch of web search queries that would best fill those gaps.',
  '',
  'Hard rules:',
  '- Propose only NEW queries — never restate a query already issued.',
  '- Each query targets an uncovered gap; be specific and search-engine-shaped',
  '  (keywords, not full sentences).',
  '- Do not invent facts. Use the overview only to sharpen wording.',
  '- Output MUST be a single JSON array of plain strings and nothing else —',
  '  no prose, no code fences, no numbering. Example: ["query one","query two"].',
].join('\n');

/**
 * The default research query-generation prompt template.
 *
 * @example
 * const gen = new FollowUpQueryGenerator({ llm: port, prompt: RESEARCH_QUERY_PROMPT });
 */
export const RESEARCH_QUERY_PROMPT: ResearchQueryPromptTemplate = {
  system: SYSTEM_PROMPT,

  buildUser(input: ResearchQueryPromptInput): string {
    const gaps =
      input.gaps.length > 0
        ? input.gaps.map((gap) => `- ${gap}`).join('\n')
        : '- (no explicit gaps; broaden coverage of the topic)';
    const issued =
      input.issued.length > 0
        ? input.issued.map((query) => `- ${query}`).join('\n')
        : '- (none yet)';

    return [
      `TOPIC: ${input.topic}`,
      '',
      'WHAT WE FOUND SO FAR (interim overview):',
      input.overview.trim().length > 0 ? input.overview.trim() : '(nothing substantive yet)',
      '',
      'UNCOVERED GAPS:',
      gaps,
      '',
      'ALREADY-ISSUED QUERIES (do not repeat):',
      issued,
      '',
      `Propose at most ${input.max} new search queries as a JSON array of strings.`,
    ].join('\n');
  },
};
