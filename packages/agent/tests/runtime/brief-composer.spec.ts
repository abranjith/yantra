import { DefaultSanitizer, DocumentStore, type PageAnalysis } from '@yantra/core';
import { TaskContractBody } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ActionObservations, actionEvidenceView } from '../../src/runtime/action-evidence.js';
import { ActionLedger } from '../../src/runtime/action-ledger.js';
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
  it('coerces a JSON object that shadows toString without throwing', () => {
    const value = composeAgentBrief(
      {
        ...base,
        table: { columns: ['Value'], rows: [[{ toString: 'shadowed' }]], row_sources: [['S2']] },
      },
      composerContext(),
    );
    if (!value.isOk) throw new Error('expected composition');
    expect(value.value.content.facets).toMatchObject({
      comparison: { rows: [['[object Object]']] },
    });
  });
  it('materializes a source corpus once across all cells citing it', () => {
    const ctx = composerContext();
    const get = vi.spyOn(ctx.documents, 'get');
    const value = composeAgentBrief(
      {
        ...base,
        table: {
          columns: ['A', 'B', 'C'],
          rows: [['Calligraphy', 'AWD', 43204]],
          row_sources: [['S2']],
        },
      },
      ctx,
    );
    expect(value.isOk).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('makes explicit section attribution visible even without inline markers', () => {
    const value = composeAgentBrief(
      { ...base, sections: [{ heading: 'Details', body_md: 'Calligraphy AWD', sources: ['S2'] }] },
      composerContext(),
    );
    if (!value.isOk) throw new Error('expected composition');
    expect(value.value.content.sections).toEqual([
      { heading: 'Details', body_md: 'Calligraphy AWD\n\n[1]', citations: [1] },
    ]);
  });
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

describe('@no-llm action attribution in Brief composition', () => {
  function context(count = 2): ComposeContext {
    const sanitizer = new DefaultSanitizer();
    const ledger = new ActionLedger({
      sanitizer,
      nowIso: () => '2026-10-18T12:00:00.000Z',
      locate: () => ({ epoch: 1, host: 'source1.test' }),
    });
    const observations = new ActionObservations(sanitizer);
    for (let index = 1; index <= count; index++) {
      ledger.record({
        kind: 'fill_committed',
        tool: 'browser_fill_form',
        field: index === 2 ? 'Password' : 'First name',
        ref: `e${index}`,
        groupKey: null,
        covers: 1,
        callId: `call-${index}`,
        identity: {
          label: index === 2 ? 'Password' : 'First name',
          origin: 'structural',
          confidence: 'medium',
          section: 'Billing',
        },
        verification:
          index === 2
            ? { resolution: null, withheld: { reason: 'password', verdict: 'exact' } }
            : { resolution: 'exact', withheld: null },
      });
      if (index !== 2) observations.record(`A${index}`, 'Avery');
    }
    return { ...composerContext(), actions: actionEvidenceView(ledger, observations) };
  }
  const composed = (ctx: ComposeContext, findings: unknown[]) => {
    const result = composeAgentBrief({ ...base, key_findings: findings }, ctx);
    if (!result.isOk) throw new Error(JSON.stringify(result.error));
    return result.value;
  };
  it('anchors a committed value only to the action that observed it', () => {
    expect(composed(context(), ['Filled First name with Avery [A1]']).verdict.flagged).toBe(0);
    expect(composed(context(), ['Filled First name with Avery [S1]']).verdict.flagged).toBe(1);
    const wrong = composed(context(), ['Filled First name with Blake [A1]']);
    expect(wrong.verdict.flagged).toBe(1);
    expect(wrong.notices[0]?.reason).toContain('blake');
    expect(composed(context(), ['Set Password to Hunter2 [A2]']).verdict.flagged).toBe(1);
    expect(composed(context(), ['Filled Password [A2]']).verdict.flagged).toBe(0);
  });
  it('retains action IDs without numbering them as page sources', () => {
    const result = composed(context(), [
      'Filled Password [A2]',
      'Filled First name with Avery [A1]',
    ]);
    expect(result.content.actions).toMatchObject([
      { id: 'A2', call_id: 'call-2', label_origin: 'structural', confidence: 'medium' },
      { id: 'A1' },
    ]);
    expect(result.content.key_findings).toMatchObject([
      { text: 'Filled Password [A2]', citations: [], actions: ['A2'], editorial: false },
      { actions: ['A1'] },
    ]);
    expect(result.summary).toMatchObject({
      cited_actions: 2,
      cited_sources: 0,
      consulted_sources: 4,
    });
  });
  it('rejects unknown actions and strips their markers only in assembled mode', () => {
    const ctx = context();
    const result = composeAgentBrief({ ...base, overview: 'Done [A9]' }, ctx);
    expect(result).toMatchObject({
      isOk: false,
      error: [{ cause: 'reference-action-unknown', values: { known: 'A1-A2' } }],
    });
    const assembled = composeAgentBrief(
      { ...base, overview: 'Done [A9]' },
      { ...ctx, mode: 'assembled' },
    );
    expect(assembled).toMatchObject({ isOk: true, value: { content: { overview: 'Done ' } } });
  });
  it('requires a page citation for table rows and keeps required_sources page-only', () => {
    const contract = TaskContractBody.parse({
      deliverable: 'table',
      subject: 'fields',
      required_fields: ['Field'],
      filters: [],
      required_sources: [],
      ranking: null,
      limit: null,
      notes: null,
    });
    const table = { columns: ['Field'], rows: [['First name']], row_sources: [['A1']] };
    expect(composeAgentBrief({ ...base, table }, { ...context(), contract })).toMatchObject({
      isOk: false,
      error: [{ cause: 'row-action-only' }],
    });
    expect(
      composeAgentBrief(
        { ...base, table: { ...table, row_sources: [['A1', 'S1']] } },
        { ...context(), contract },
      ).isOk,
    ).toBe(true);
    expect(
      composeAgentBrief(
        { ...base, table },
        { ...context(), contract: { ...contract, deliverable: 'actions' } },
      ).isOk,
    ).toBe(true);
    const required = composed(
      {
        ...context(),
        contract: { ...contract, deliverable: 'actions', required_sources: ['source1.test'] },
      },
      ['Filled First name with Avery [A1]'],
    );
    expect(required.evidence.deliverableGaps.join(' ')).toContain(
      'nothing in the answer is cited from',
    );
  });
  it('caps public evidence and emits exactly one overflow notice', () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({
      text: 'Filled First name',
      sources: Array.from(
        { length: Math.min(6, 41 - index * 6) },
        (_, offset) => `A${index * 6 + offset + 1}`,
      ),
    }));
    const result = composed(context(41), findings);
    expect(result.content.actions).toHaveLength(40);
    expect(result.notices.filter((notice) => notice.source === 'actions')).toEqual([
      {
        kind: 'other',
        source: 'actions',
        reason: '1 further cited actions are listed in tool-calls.jsonl',
      },
    ]);
  });
  it('ignores literal action markers when no action view is active', () => {
    const input = { ...base, overview: 'Literal [A1]', key_findings: ['Literal [A1]'] };
    const before = composeAgentBrief(input, composerContext());
    const after = composeAgentBrief(input, { ...composerContext(), actions: null });
    expect(after).toEqual(before);
  });
});
