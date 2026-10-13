import { DocumentStore } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { composeAgentBrief, type ComposeContext } from '../../src/runtime/brief-composer.js';
import type { EvidenceEntry } from '../../src/runtime/run-services.js';

export function composerContext(): ComposeContext {
  const documents = new DocumentStore();
  const evidence: EvidenceEntry[] = [1, 2, 3, 4].map((n) => ({
    sourceId: `S${n}`,
    url: `https://source${n}.test/`,
    finalUrl: null,
    title: `Source ${n}`,
    excerpt: 'Calligraphy AWD Price 43204',
    fetchedAt: '2026-10-10T00:00:00.000Z',
    publishedAt: null,
    tool: 'web_fetch',
  }));
  return { documents, evidence, contract: null, mode: 'tool' };
}
const base = { title: 'Results', overview: '', key_findings: [] };
describe('@no-llm Brief composer', () => {
  it('numbers cited sources first, in content reading order', () => {
    const result = composeAgentBrief(
      {
        ...base,
        overview: 'Evidence [S3] then [S1]',
        key_findings: [{ text: 'AWD', sources: ['S2'] }],
        sections: [{ heading: 'Details', body_md: 'Read [S2]', sources: ['S4'] }],
      },
      composerContext(),
    );
    expect(result.isOk).toBe(true);
    if (!result.isOk) return;
    expect(result.value.content.overview).toBe('Evidence [1] then [2]');
    expect(result.value.content.key_findings).toEqual([
      { text: 'AWD', citations: [3], editorial: false },
    ]);
    expect(result.value.content.sources).toEqual(
      [3, 1, 2, 4].map((n) =>
        expect.objectContaining({ url: `https://source${n}.test/`, cited: true }),
      ),
    );
  });
  it('leaves consulted sources after cited ones and makes inline findings non-editorial', () => {
    const result = composeAgentBrief(
      { ...base, key_findings: ['AWD [S2]', 'Commentary'] },
      composerContext(),
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.content.key_findings).toEqual([
      { text: 'AWD [1]', citations: [1], editorial: false },
      { text: 'Commentary', citations: [], editorial: true },
    ]);
    expect(result.value.content.sources).toEqual(
      [2, 1, 3, 4].map((n, i) =>
        expect.objectContaining({ url: `https://source${n}.test/`, cited: i === 0 }),
      ),
    );
  });
  it('collects unknown-source and unknown-anchor issues', () => {
    const result = composeAgentBrief(
      { ...base, key_findings: [{ text: 'x', sources: ['S9', 'S2#r9'] }] },
      composerContext(),
    );
    expect(result).toEqual({
      isOk: false,
      error: [
        expect.objectContaining({
          cause: 'reference-unknown',
          values: expect.objectContaining({ known: 'S1–S4' }),
        }),
        expect.objectContaining({ cause: 'reference-anchor-unknown' }),
      ],
    });
  });
  it('rejects numeric citations in tool mode and deletes them in fallback mode', () => {
    expect(composeAgentBrief({ ...base, overview: 'Value [2]' }, composerContext()).isOk).toBe(
      false,
    );
    const result = composeAgentBrief(
      { ...base, overview: 'Value [2] [S99]' },
      { ...composerContext(), mode: 'assembled' },
    );
    if (!result.isOk) throw new Error('expected fallback composition');
    expect(result.value.content.overview).toBe('Value  ');
  });
  it('deduplicates evidence IDs and retains null-ID sources as consulted', () => {
    const ctx = composerContext();
    const result = composeAgentBrief(
      { ...base, overview: '[S1]' },
      {
        ...ctx,
        evidence: [ctx.evidence[0]!, ctx.evidence[0]!, { ...ctx.evidence[1]!, sourceId: null }],
      },
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.summary).toMatchObject({ cited_sources: 1, consulted_sources: 1 });
  });
  it('honors supplied URLs only with no evidence ledger', () => {
    const result = composeAgentBrief(
      { ...base, sources: ['https://outside.test/'] },
      { ...composerContext(), evidence: [] },
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.content.sources).toEqual(['https://outside.test/']);
  });
});
