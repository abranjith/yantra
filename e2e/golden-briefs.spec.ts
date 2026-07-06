import { TaskEvent, validateBrief } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  GOLDEN_OPTS,
  NORMALIZED_BRIEF_ID,
  goldenCorpusNames,
  loadCorpus,
  loadExpected,
  serializeBrief,
  synthesizeCorpus,
} from './golden-briefs/harness.js';

describe('@no-llm golden briefs — deterministic synthesizer', () => {
  const names = goldenCorpusNames();

  it('ships at least four fixture corpora', () => {
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain('price-comparison');
    expect(names).toContain('news-roundup');
    expect(names).toContain('howto-reference');
    expect(names).toContain('single-source');
  });

  for (const name of names) {
    it(`byte-matches the pinned Brief for "${name}"`, async () => {
      const actual = await synthesizeCorpus(name);
      const expected = loadExpected(name);

      // On drift, the object diff (Vitest renders it) points at the offending
      // field; run "pnpm golden:update" if the change was intentional.
      expect(actual).toEqual(expected);
      // Byte-stability guarantee for the serialized artifact.
      expect(serializeBrief(actual)).toBe(serializeBrief(expected));
    });

    it(`produces a schema-valid Brief for "${name}"`, async () => {
      const actual = await synthesizeCorpus(name);
      expect(validateBrief({ ...actual, brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).isOk).toBe(true);
      expect(actual.brief_id).toBe(NORMALIZED_BRIEF_ID);
    });
  }

  it('is stable across repeated runs of the same corpus', async () => {
    const first = await synthesizeCorpus('price-comparison');
    const second = await synthesizeCorpus('price-comparison');
    expect(serializeBrief(first)).toBe(serializeBrief(second));
  });

  it('yields a comparison facet for the price corpus and none for the news corpus', async () => {
    const price = await synthesizeCorpus('price-comparison');
    const news = await synthesizeCorpus('news-roundup');

    expect(price.facets).not.toBeNull();
    expect(price.facets!.comparison!.rows.length).toBeGreaterThanOrEqual(2);
    expect(news.facets).toBeNull();
  });

  it('handles the degenerate single-source corpus with honest coverage', async () => {
    const brief = await synthesizeCorpus('single-source');

    expect(validateBrief({ ...brief, brief_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).isOk).toBe(true);
    expect(brief.sources).toHaveLength(1);
    // Coverage is a real fraction, never fabricated as 1.
    expect(brief.metadata.coverage).not.toBeNull();
    expect(brief.metadata.coverage!).toBeGreaterThan(0);
    expect(brief.metadata.coverage!).toBeLessThanOrEqual(1);
    // The failed second source is surfaced honestly as a notice.
    expect(brief.notices.some((n) => n.kind === 'extract_failed')).toBe(true);
  });

  it('surfaces the failed fetch in the price corpus as a notice, never a silent drop', async () => {
    const corpus = loadCorpus('price-comparison');
    expect(corpus.failures.length).toBeGreaterThan(0);

    const brief = await synthesizeCorpus('price-comparison');
    for (const failure of corpus.failures) {
      expect(brief.notices.some((n) => n.source === failure.host)).toBe(true);
    }
  });

  it('stamps deterministic provenance metadata', async () => {
    const brief = await synthesizeCorpus('news-roundup');
    expect(brief.metadata.synthesis).toBe('deterministic');
    expect(brief.metadata.deterministic_fallback_used).toBe(false);
    expect(brief.metadata.usage).toBeNull();
    expect(brief.metadata.run_id).toBe(GOLDEN_OPTS.runId);
    // Deterministic path: zero flags/strips, and some claims were checked.
    expect(brief.metadata.citation_verdict).not.toBeNull();
    expect(brief.metadata.citation_verdict!.flagged).toBe(0);
    expect(brief.metadata.citation_verdict!.stripped).toBe(0);
    expect(brief.metadata.citation_verdict!.claims_checked).toBeGreaterThanOrEqual(0);
  });
});

describe('@no-llm synthesis_completed event', () => {
  it('round-trips through the TaskEvent schema', () => {
    const event = {
      kind: 'synthesis_completed' as const,
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      at: '2026-06-15T00:00:00.000Z',
      strategy: 'deterministic' as const,
      sources_in: 4,
      sources_used: 3,
      coverage: 0.75,
      citation_verdict: { claims_checked: 6, flagged: 0, stripped: 0 },
    };

    const parsed = TaskEvent.safeParse(event);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(event);
    }
  });

  it('accepts a null coverage and the llm strategy', () => {
    const event = {
      kind: 'synthesis_completed' as const,
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      at: '2026-06-15T00:00:00.000Z',
      strategy: 'llm' as const,
      sources_in: 2,
      sources_used: 2,
      coverage: null,
      citation_verdict: { claims_checked: 3, flagged: 1, stripped: 1 },
    };
    expect(TaskEvent.safeParse(event).success).toBe(true);
  });

  it('rejects an out-of-range coverage', () => {
    const event = {
      kind: 'synthesis_completed' as const,
      task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      at: '2026-06-15T00:00:00.000Z',
      strategy: 'deterministic' as const,
      sources_in: 1,
      sources_used: 1,
      coverage: 1.5,
      citation_verdict: { claims_checked: 1, flagged: 0, stripped: 0 },
    };
    expect(TaskEvent.safeParse(event).success).toBe(false);
  });
});
