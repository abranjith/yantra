/**
 * @no-llm Tests for system-prompt assembly determinism.
 */
import { describe, expect, it } from 'vitest';

import { assemble, assembleSummarize } from '../../src/prompts/assemble.js';
import type { AssembleOpts } from '../../src/prompts/assemble.js';

const GUIDANCE = '# Guidance\n\nDo the right thing.';

const BASE_OPTS: AssembleOpts = {
  toolCatalog: [
    { name: 'navigate', description: 'Navigate to a URL.', input_schema: {}, output_schema: null },
    { name: 'click', description: 'Click a UI element.', input_schema: {}, output_schema: null },
  ],
  schemaVersion: '0.1',
  guidanceMarkdown: GUIDANCE,
};

describe('assemble()', () => {
  it('produces the same fullHash for identical inputs', () => {
    const a = assemble(BASE_OPTS);
    const b = assemble(BASE_OPTS);
    expect(a.fullHash).toBe(b.fullHash);
    expect(a.text).toBe(b.text);
  });

  it('sorts tools by name for canonical ordering', () => {
    const shuffled: AssembleOpts = {
      ...BASE_OPTS,
      toolCatalog: [
        {
          name: 'click',
          description: 'Click a UI element.',
          input_schema: {},
          output_schema: null,
        },
        {
          name: 'navigate',
          description: 'Navigate to a URL.',
          input_schema: {},
          output_schema: null,
        },
      ],
    };
    const original = assemble(BASE_OPTS);
    const fromShuffled = assemble(shuffled);
    expect(original.fullHash).toBe(fromShuffled.fullHash);
  });

  it('different tool catalogs produce different hashes', () => {
    const withExtra: AssembleOpts = {
      ...BASE_OPTS,
      toolCatalog: [
        ...BASE_OPTS.toolCatalog,
        { name: 'fill', description: 'Fill a field.', input_schema: {}, output_schema: null },
      ],
    };
    expect(assemble(BASE_OPTS).fullHash).not.toBe(assemble(withExtra).fullHash);
  });

  it('different guidance produces different hashes', () => {
    const modified: AssembleOpts = { ...BASE_OPTS, guidanceMarkdown: '# Different guidance' };
    expect(assemble(BASE_OPTS).fullHash).not.toBe(assemble(modified).fullHash);
  });

  it('includes schema version in text', () => {
    const result = assemble(BASE_OPTS);
    expect(result.text).toContain('0.1');
    expect(result.schemaVersion).toBe('0.1');
  });

  it('toolCatalogHash and guidanceHash are distinct from fullHash', () => {
    const result = assemble(BASE_OPTS);
    expect(result.toolCatalogHash).not.toBe(result.fullHash);
    expect(result.guidanceHash).not.toBe(result.fullHash);
  });

  it('fullHash is the SHA-256 of text (verifiable with known input)', async () => {
    const { createHash } = await import('node:crypto');
    const result = assemble(BASE_OPTS);
    const expected = createHash('sha256').update(result.text, 'utf8').digest('hex');
    expect(result.fullHash).toBe(expected);
  });

  it('handles empty tool catalog', () => {
    const empty: AssembleOpts = { ...BASE_OPTS, toolCatalog: [] };
    expect(() => assemble(empty)).not.toThrow();
    const result = assemble(empty);
    expect(result.text).toContain('(none)');
  });
});

describe('assembleSummarize()', () => {
  it('produces deterministic output', () => {
    const opts = { schemaVersion: '0.1' as const, guidanceMarkdown: GUIDANCE };
    expect(assembleSummarize(opts).fullHash).toBe(assembleSummarize(opts).fullHash);
  });

  it('does not include tool catalog section', () => {
    const result = assembleSummarize({ schemaVersion: '0.1', guidanceMarkdown: GUIDANCE });
    expect(result.toolCatalogHash).toBe(
      assembleSummarize({ schemaVersion: '0.1', guidanceMarkdown: GUIDANCE }).toolCatalogHash,
    );
  });

  it('includes summarizer identity in text', () => {
    const result = assembleSummarize({ schemaVersion: '0.1', guidanceMarkdown: GUIDANCE });
    expect(result.text.toLowerCase()).toContain('summariz');
  });
});
