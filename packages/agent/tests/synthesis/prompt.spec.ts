// @no-llm
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SYNTHESIS_PROMPT_VERSION,
  YANTRA_SYNTHESIS_PROMPT,
  type SynthesisPromptSourceInput,
  type SynthesisUserPromptInput,
} from '../../src/synthesis/prompt.js';

const source = (
  n: number,
  overrides: Partial<SynthesisPromptSourceInput> = {},
): SynthesisPromptSourceInput => ({
  n,
  host: `host-${n}.test`,
  title: `Title ${n}`,
  text: `Body of source ${n}.`,
  ...overrides,
});

const baseInput = (
  overrides: Partial<SynthesisUserPromptInput> = {},
): SynthesisUserPromptInput => ({
  query: 'what changed in Q3?',
  sources: [source(1), source(2)],
  detail: 'standard',
  length: 'medium',
  ...overrides,
});

describe('@no-llm YANTRA_SYNTHESIS_PROMPT.system', () => {
  it('states the citation and no-fabrication rules and the JSON-only contract', () => {
    const system = YANTRA_SYNTHESIS_PROMPT.system;

    expect(system).toContain(SYNTHESIS_PROMPT_VERSION);
    expect(system).toContain('Answer first');
    expect(system).toMatch(/never invent a number/i);
    expect(system).toMatch(/single JSON object/i);
    expect(system).toMatch(/never output a URL/i);
    for (const field of ['"title"', '"overview"', '"key_findings"', '"sections"', '"facets"']) {
      expect(system).toContain(field);
    }
  });

  it('is a stable static string', () => {
    expect(YANTRA_SYNTHESIS_PROMPT.system).toBe(YANTRA_SYNTHESIS_PROMPT.system);
    expect(YANTRA_SYNTHESIS_PROMPT.system.length).toBeGreaterThan(200);
  });
});

describe('@no-llm YANTRA_SYNTHESIS_PROMPT.buildUser', () => {
  it('numbers sources contiguously from 1 and includes every host and title', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildUser(
      baseInput({ sources: [source(1), source(2), source(3)] }),
    );

    expect(prompt).toContain('[1] host-1.test — Title 1');
    expect(prompt).toContain('[2] host-2.test — Title 2');
    expect(prompt).toContain('[3] host-3.test — Title 3');
    expect(prompt.indexOf('[1] host-1.test')).toBeLessThan(prompt.indexOf('[2] host-2.test'));
    expect(prompt).toContain('Valid citation numbers: 1-3.');
  });

  it('includes the query and each source body', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput());

    expect(prompt).toContain('what changed in Q3?');
    expect(prompt).toContain('Body of source 1.');
    expect(prompt).toContain('Body of source 2.');
  });

  it('renders an untitled placeholder rather than "null"', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildUser(
      baseInput({ sources: [source(1, { title: null })] }),
    );

    expect(prompt).toContain('[1] host-1.test — (untitled)');
    expect(prompt).not.toContain('— null');
  });

  it('states different budgets for short and long lengths', () => {
    const short = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ length: 'short' }));
    const long = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ length: 'long' }));

    expect(short).toContain('up to 3 key findings');
    expect(long).toContain('up to 10 key findings');
    expect(short).not.toBe(long);
  });

  it('varies the depth instruction per detail level', () => {
    const overview = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ detail: 'overview' }));
    const standard = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ detail: 'standard' }));
    const full = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ detail: 'full' }));

    expect(overview).toContain('empty "sections" array');
    expect(standard).toContain('Depth: standard');
    expect(full).toContain('Depth: full');
    expect(new Set([overview, standard, full]).size).toBe(3);
  });

  it('includes personalization only when present and non-empty', () => {
    const withContext = YANTRA_SYNTHESIS_PROMPT.buildUser(
      baseInput({ personalization: 'Prefers metric units.' }),
    );
    const without = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput());
    const empty = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ personalization: '' }));

    expect(withContext).toContain('Reader context');
    expect(withContext).toContain('Prefers metric units.');
    expect(without).not.toContain('Reader context');
    expect(empty).not.toContain('Reader context');
  });

  it('includes hints only when present and non-empty', () => {
    const withHints = YANTRA_SYNTHESIS_PROMPT.buildUser(
      baseInput({ hints: ['pricing', 'availability'] }),
    );
    const without = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ hints: [] }));

    expect(withHints).toContain('Subtopics to cover');
    expect(withHints).toContain('- pricing');
    expect(withHints).toContain('- availability');
    expect(without).not.toContain('Subtopics to cover');
  });

  it('tells the model not to answer from memory when no sources were supplied', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildUser(baseInput({ sources: [] }));

    expect(prompt).toContain('## Sources\n(none)');
    expect(prompt).toMatch(/do not answer from memory/i);
    expect(prompt).not.toContain('Valid citation numbers');
  });

  it('is deterministic for identical input', () => {
    const input = baseInput({ hints: ['a'], personalization: 'p' });

    expect(YANTRA_SYNTHESIS_PROMPT.buildUser(input)).toBe(YANTRA_SYNTHESIS_PROMPT.buildUser(input));
  });
});

describe('@no-llm YANTRA_SYNTHESIS_PROMPT.buildReprompt', () => {
  it('lists every issue pointer and message', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildReprompt([
      { pointer: 'key_findings/0/citations', message: 'citation 9 has no source' },
      { pointer: 'title', message: 'must not be empty' },
    ]);

    expect(prompt).toContain('- key_findings/0/citations: citation 9 has no source');
    expect(prompt).toContain('- title: must not be empty');
    expect(prompt).toMatch(/resend the complete JSON object/i);
  });

  it('renders an empty pointer as (root)', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildReprompt([{ pointer: '', message: 'bad shape' }]);

    expect(prompt).toContain('- (root): bad shape');
  });

  it('still asks for a resend when no issues were supplied', () => {
    const prompt = YANTRA_SYNTHESIS_PROMPT.buildReprompt([]);

    expect(prompt).toContain('(root)');
    expect(prompt).toMatch(/resend the complete JSON object/i);
  });
});

describe('@no-llm synthesis prompt layering boundary', () => {
  it('does not import @yantra/core', () => {
    const promptFile = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../src/synthesis/prompt.ts',
    );

    expect(readFileSync(promptFile, 'utf8')).not.toMatch(/from\s+['"]@yantra\/core/);
  });
});
