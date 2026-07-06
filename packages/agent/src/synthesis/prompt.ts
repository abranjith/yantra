/**
 * Synthesis prompt templates (agent-side).
 *
 * The prompt *text* lives here, next to the other agent prompts, but the
 * `LlmSynthesizer` that consumes it lives in `packages/core` — and `core`
 * cannot import `agent` (layering rule, plan §6). So this module exposes a
 * plain-data template object matching the structural shape `core` expects
 * (`SynthesisPromptTemplate` in `packages/core/src/synthesis/types.ts`);
 * `apps/cli` passes it in at wiring time.
 *
 * The template only assembles instructions and the pre-numbered source list;
 * the actual document text handed to it has already passed the sanitizer
 * chokepoint in `LlmSynthesizer`. This module never touches unsanitized
 * content.
 */

/** One numbered source block presented to the model. */
export interface SynthesisPromptSource {
  /** Citation number (1..N, cluster order). */
  readonly n: number;
  /** Source host. */
  readonly host: string;
  /** Page title, or null. */
  readonly title: string | null;
  /** Sanitized extracted text. */
  readonly text: string;
}

/** Inputs the user-prompt builder receives. */
export interface SynthesisPromptInput {
  readonly query: string;
  readonly sources: readonly SynthesisPromptSource[];
  readonly detail: 'overview' | 'standard' | 'full';
  readonly length: 'short' | 'medium' | 'long';
  /** Optional subtopic hints (FEAT-017) to organize the document by. */
  readonly hints?: readonly string[];
  /**
   * Optional sanitized personalization context (FEAT-018) — a short preference
   * summary used to tailor emphasis/units. Already sanitized upstream; treated
   * as trusted, non-authoritative guidance (never a source of facts).
   */
  readonly personalization?: string;
}

/** Structural shape the core `LlmSynthesizer` injects and calls. */
export interface SynthesisPromptTemplate {
  readonly system: string;
  buildUser(input: SynthesisPromptInput): string;
  buildReprompt(issues: readonly { pointer: string; message: string }[]): string;
}

/** Key-finding budget advertised to the model per requested length. */
const LENGTH_BUDGET: Readonly<Record<SynthesisPromptInput['length'], number>> = {
  short: 3,
  medium: 6,
  long: 10,
};

const SYSTEM_PROMPT = [
  "You are Yantra's cross-source synthesizer. You turn several extracted web",
  'articles into ONE trustworthy briefing document. You reason across sources —',
  'you do not summarize them one by one.',
  '',
  'Hard rules:',
  '- Answer first. The `overview` opens with the direct answer to the query.',
  '- Every factual claim MUST carry an inline citation like [1] or [2][3] that',
  '  refers ONLY to the numbered sources provided. Never invent a source number.',
  '- If you write a sentence that is your own commentary rather than a sourced',
  '  fact, mark that key finding with "editorial": true and leave its citations',
  '  array empty. This is the ONLY legal way to have an uncited claim.',
  '- Do not fabricate numbers, prices, or dates. Only state a figure if it',
  '  appears in a cited source.',
  '- Output MUST be a single JSON object and nothing else — no prose, no code',
  '  fences. Do not include source text back verbatim beyond short quotes.',
  '',
  'JSON shape (the engine supplies id, sources, and metadata — you supply only',
  'the content fields):',
  '{',
  '  "title": string,',
  '  "overview": string (Markdown, inline [n] citations),',
  '  "key_findings": [',
  '    { "text": string, "citations": number[], "editorial": boolean,',
  '      "facet": object | null }',
  '  ],',
  '  "sections": [',
  '    { "heading": string, "body_md": string, "citations": number[] }',
  '  ],',
  '  "facets": { "comparison": { "columns": string[], "rows": (string|number|boolean|null)[][] } } | null',
  '}',
].join('\n');

/**
 * The default synthesis prompt template.
 *
 * @example
 * const llm = new LlmSynthesizer({ llm: port, prompt: SYNTHESIS_PROMPT, deterministic });
 */
export const SYNTHESIS_PROMPT: SynthesisPromptTemplate = {
  system: SYSTEM_PROMPT,

  buildUser(input: SynthesisPromptInput): string {
    const budget = LENGTH_BUDGET[input.length];
    const includeSections = input.detail !== 'overview';

    const sourceBlocks = input.sources.map((source) => {
      const heading = `SOURCE [${source.n}] — ${source.host}${
        source.title ? ` — ${source.title}` : ''
      }`;
      return `${heading}\n${source.text}`;
    });

    const hintLine =
      input.hints && input.hints.length > 0
        ? `Organize the sections around these subtopics where the sources support them: ${input.hints.join(
            '; ',
          )}.`
        : null;

    const personalizationLine =
      input.personalization && input.personalization.trim().length > 0
        ? `About this user (tailor emphasis, units, and examples to fit — but never treat ` +
          `this as a source of facts, and never cite it): ${input.personalization.trim()}`
        : null;

    return [
      `QUERY: ${input.query}`,
      '',
      `Produce a Brief answering the query. Emit at most ${budget} key findings, ranked`,
      'by importance. ' +
        (includeSections
          ? 'Include detailed `sections` grouping related findings.'
          : 'Leave `sections` as an empty array.'),
      ...(hintLine ? [hintLine] : []),
      ...(personalizationLine ? [personalizationLine] : []),
      'Cite only the numbered sources below. Respond with the JSON object only.',
      '',
      '=== NUMBERED SOURCES ===',
      sourceBlocks.join('\n\n'),
    ].join('\n');
  },

  buildReprompt(issues: readonly { pointer: string; message: string }[]): string {
    const lines = issues.map((issue) => `  - ${issue.pointer || '(root)'}: ${issue.message}`);
    return [
      'Your previous JSON failed validation. Fix exactly these issues and re-emit',
      'the COMPLETE corrected JSON object (no prose, no code fences):',
      '',
      ...lines,
    ].join('\n');
  },
};
