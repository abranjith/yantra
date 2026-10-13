import { DocumentStore, type PageAnalysis } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { composeAgentBrief, type ComposeContext } from '../../src/runtime/brief-composer.js';
import type { EvidenceEntry } from '../../src/runtime/run-services.js';

export function composerContext(): ComposeContext {
  const documents = new DocumentStore();
  for (let n = 1; n <= 4; n += 1)
    documents.observe(`https://source${n}.test/`, {
      title: `Source ${n}`,
      tool: 'browser_extract',
    });
  const analysis: PageAnalysis = {
    shape: 'collection',
    records: [1, 2, 3].map((n) => ({
      key: String(n),
      title: 'Calligraphy AWD',
      url: null,
      segments: ['Price 43204'],
      fields: [{ label: 'Price', value: '43204' }],
      numbers: [],
      links: [],
    })),
    readableText: 'Calligraphy AWD Price 43204',
    fields: [],
    tables: [],
    structured: [],
    links: [],
    recordLinkCount: 0,
    coverage: { shape_basis: 'test', fetch_mode: 'http', not_found: [], omitted: [] },
  };
  documents.attachPage('S2', analysis, { delivered: 'full', article: null });
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
  it('resolves stable record anchors and flags unsupported cells without removing them', () => {
    const result = composeAgentBrief(
      {
        ...base,
        table: {
          columns: ['Trim', 'Price'],
          rows: [['Calligraphy AWD', 41000]],
          row_sources: [['S2#r1']],
        },
      },
      composerContext(),
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.verdict).toEqual({ claims_checked: 2, flagged: 1, stripped: 0 });
    expect(result.value.notices[0]?.reason).toContain('table/rows/0/1');
    expect(result.value.content.facets).toMatchObject({
      comparison: { rows: [['Calligraphy AWD', 41000]], row_citations: [[1]] },
    });
  });
  it('anchors grouped prices to records and produces a zero verdict for commentary', () => {
    const result = composeAgentBrief(
      { ...base, table: { columns: ['Price'], rows: [['$43,204']], row_sources: [['S2#r1']] } },
      composerContext(),
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.verdict).toEqual({ claims_checked: 1, flagged: 0, stripped: 0 });
    const editorial = composeAgentBrief(
      { ...base, key_findings: ['Commentary'] },
      composerContext(),
    );
    if (!editorial.isOk) throw new Error('expected composition');
    expect(editorial.value.verdict).toEqual({ claims_checked: 0, flagged: 0, stripped: 0 });
  });
  it('publishes cited table rows and coerces non-scalar cells', () => {
    const result = composeAgentBrief(
      {
        ...base,
        table: {
          columns: ['Seller', 'Price'],
          rows: [
            ['Calligraphy', 43204],
            ['AWD', { value: 3 }],
            ['x\u001b[31m', null],
          ],
          row_sources: [['S2'], ['S2', 'S4'], ['S4']],
        },
      },
      composerContext(),
    );
    if (!result.isOk) throw new Error('expected composition');
    expect(result.value.content.facets).toEqual({
      comparison: {
        columns: ['Seller', 'Price'],
        rows: [
          ['Calligraphy', 43204],
          ['AWD', '[object Object]'],
          ['x[31m', null],
        ],
        row_citations: [[1], [1, 2], [2]],
      },
    });
  });
  it('reports every table shape problem with precise pointers', () => {
    const result = composeAgentBrief(
      { ...base, table: { columns: ['A', 'B'], rows: [['x'], ['x', 'y']], row_sources: [['S1']] } },
      composerContext(),
    );
    if (result.isOk) throw new Error('expected issues');
    expect(result.error).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cause: 'row-width', pointer: 'table/rows/0' }),
        expect.objectContaining({ cause: 'row-sources-length', pointer: 'table/row_sources' }),
        expect.objectContaining({ cause: 'row-uncited', pointer: 'table/row_sources/1' }),
      ]),
    );
  });
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
