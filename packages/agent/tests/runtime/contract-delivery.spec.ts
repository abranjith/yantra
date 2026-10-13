import { DocumentStore } from '@yantra/core';
import { TaskContractBody, createBrief, validateBrief } from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  composeAgentBrief,
  type ComposeContext,
  type ComposedBrief,
} from '../../src/runtime/brief-composer.js';
import { boundedNotice, columnMatchesField } from '../../src/runtime/contract-delivery.js';

function context(overrides: Partial<TaskContractBody> = {}): ComposeContext {
  return {
    mode: 'tool',
    documents: new DocumentStore(),
    evidence: [1, 2].map((n) => ({
      sourceId: `S${n}`,
      url: `https://${n === 1 ? 'listings' : 'other'}.test/`,
      finalUrl: null,
      title: 'Dealer AWD',
      excerpt: 'Dealer Price 43204 Blue Black AWD',
      fetchedAt: '2026-10-10T00:00:00.000Z',
      publishedAt: null,
      tool: 'web_fetch',
    })),
    contract: TaskContractBody.parse({
      deliverable: 'table',
      subject: 'Cars',
      required_fields: ['dealer', 'price', 'exterior color', 'interior color'],
      filters: [],
      required_sources: ['listings.test'],
      ranking: null,
      limit: null,
      notes: null,
      ...overrides,
    }),
  };
}
const base = { title: 'Cars', overview: '', key_findings: [] };
const columns = ['Dealer', 'Price', 'Exterior Color (paint)', 'Interior Color'];
const cells = ['Dealer', 43204, 'Blue', 'Black'];
function composed(payload: unknown, ctx = context()): ComposedBrief {
  const result = composeAgentBrief(payload, ctx);
  if (!result.isOk) throw new Error(JSON.stringify(result.error));
  return result.value;
}
describe('@no-llm contract delivery', () => {
  it('reports every contract filter and preserves extras in delivery order', () => {
    const value = composed(
      {
        ...base,
        constraints: [
          { name: 'Drivetrain', value: 'AWD', status: 'verified', sources: ['S1'] },
          { name: 'distance', value: '50 mi', status: 'violated' },
        ],
      },
      context({
        deliverable: 'answer',
        filters: [
          { name: 'condition', value: 'new' },
          { name: 'drivetrain', value: 'AWD' },
        ],
      }),
    );
    expect(value.content.constraints).toEqual([
      { name: 'condition', value: 'new', status: 'unverified', citations: [] },
      { name: 'Drivetrain', value: 'AWD', status: 'verified', citations: [1] },
      { name: 'distance', value: '50 mi', status: 'violated', citations: [] },
    ]);
    expect(value.notices.map((notice) => notice.reason)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('not reported by the agent'),
        'Not met: distance = 50 mi',
      ]),
    );
  });
  it('downgrades unsupported verification with its cause', () => {
    const value = composed(
      { ...base, constraints: [{ name: 'drivetrain', value: 'AWD', status: 'verified' }] },
      context({ deliverable: 'answer' }),
    );
    expect(value.content.constraints).toEqual([
      { name: 'drivetrain', value: 'AWD', status: 'unverified', citations: [] },
    ]);
    expect(
      value.notices.some((notice) => notice.reason.includes('marked verified without evidence')),
    ).toBe(true);
  });
  it('omits constraints when neither contract nor payload declares any', () => {
    expect(composed(base, { ...context(), contract: null }).content).not.toHaveProperty(
      'constraints',
    );
  });
  it('always produces protocol-valid constraint citations and statuses', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom('condition', 'drivetrain', 'distance'),
            value: fc.constantFrom('AWD', 'new', '50'),
            status: fc.constantFrom('verified', 'unverified', 'violated'),
            sources: fc.constantFrom([], ['S1']),
          }),
          { maxLength: 12 },
        ),
        (constraints) => {
          const value = composed({ ...base, constraints }, context({ deliverable: 'answer' }));
          const sources = (value.content.sources as Record<string, unknown>[]).map((source, i) => ({
            n: i + 1,
            host: 'listings.test',
            final_url: null,
            title: null,
            published_at: null,
            ...source,
          }));
          const result = validateBrief({
            ...createBrief({ task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', title: 'Test', overview: '' }),
            ...value.content,
            sources,
          });
          expect(result.isOk).toBe(true);
        },
      ),
    );
  });
  it('partitions rows and cited findings into one structured alternatives section', () => {
    const value = composed({
      ...base,
      key_findings: [{ text: 'Dealer', sources: ['S2'] }, 'Editorial'],
      table: {
        columns,
        rows: [cells, cells, cells, ['Other | Dealer', 43204, 'Blue', 'Black']],
        row_sources: [['S1'], ['S1'], ['S1'], ['S2']],
      },
    });
    expect(value.content.facets).toMatchObject({
      comparison: { rows: [cells, cells, cells], row_citations: [[2], [2], [2]] },
    });
    expect(value.content.key_findings).toEqual([
      { text: 'Editorial', citations: [], editorial: true },
    ]);
    expect(value.content.sections).toEqual([
      expect.objectContaining({
        kind: 'alternatives',
        heading: 'Alternatives (not from listings.test)',
        body_md: expect.stringContaining('Other \\| Dealer'),
        citations: [1],
      }),
    ]);
    expect(value.notices.some((notice) => notice.reason.includes('1 rows and 1 findings'))).toBe(
      true,
    );
  });
  it('keeps mixed-source rows in the answer', () => {
    expect(
      composed({ ...base, table: { columns, rows: [cells], row_sources: [['S2', 'S1']] } }).summary
        .alternatives_rows,
    ).toBe(0);
  });
  it('publishes all-off-contract results as alternatives with honest gaps', () => {
    const value = composed({ ...base, table: { columns, rows: [cells], row_sources: [['S2']] } });
    expect(value.content.facets).toBeNull();
    expect(value.notices[0]?.reason).toContain('nothing in the answer is cited from listings.test');
    expect(value.notices[0]?.reason).toContain('no row came from listings.test');
  });
  it('requires missing fields unless fulfillment names them', () => {
    const payload = {
      ...base,
      table: { columns: columns.slice(0, 3), rows: [cells.slice(0, 3)], row_sources: [['S1']] },
    };
    expect(composeAgentBrief(payload, context())).toMatchObject({
      isOk: false,
      error: [
        expect.objectContaining({
          cause: 'contract-field-missing',
          values: { field: 'interior color' },
        }),
      ],
    });
    expect(
      composed({
        ...payload,
        fulfillment: {
          met: true,
          unmet: [{ item: 'interior color', reason: 'Page did not show it' }],
        },
      }).notices[0]?.reason,
    ).toContain('Page did not show it');
  });
  it('uses exact field tokens without fuzzy spelling', () => {
    expect(columnMatchesField('Interior colour', 'interior color')).toBe(false);
    expect(columnMatchesField('Exterior Color (paint)', 'exterior color')).toBe(true);
  });
  it('fills empty required cells and excludes placeholders from anchoring', () => {
    const value = composed({
      ...base,
      table: {
        columns,
        rows: [[...cells.slice(0, 3), null], [...cells.slice(0, 3), ''], cells],
        row_sources: [['S1'], ['S1'], ['S1']],
      },
    });
    expect(value.notices[0]?.reason).toContain('interior color: not shown for 2 of 3 rows');
    expect(value.content.facets).toMatchObject({
      comparison: {
        rows: [
          [...cells.slice(0, 3), 'not shown on source'],
          [...cells.slice(0, 3), 'not shown on source'],
          cells,
        ],
      },
    });
    expect(value.verdict.claims_checked).toBe(10);
  });
  it('requires a table only for table contracts, with a fulfillment escape', () => {
    expect(composeAgentBrief(base, context())).toMatchObject({
      isOk: false,
      error: [expect.objectContaining({ cause: 'contract-table-missing' })],
    });
    expect(composed(base, context({ deliverable: 'answer' })).content.facets).toBeNull();
    expect(
      composed({
        ...base,
        fulfillment: { met: false, unmet: [{ item: 'table', reason: 'Blocked' }] },
      }).notices[0]?.reason,
    ).toContain('table (Blocked)');
  });
  it('never enforces a missing contract but still reports agent unmet items', () => {
    const ctx = { ...context(), contract: null };
    const value = composed(
      { ...base, fulfillment: { met: true, unmet: [{ item: 'colors', reason: 'not shown' }] } },
      ctx,
    );
    expect(value.notices[0]?.reason).toBe('Not delivered: colors (not shown)');
    expect(value.summary.contract_gaps).toBe(1);
  });
  it('turns structural issues into gaps in fallback mode', () => {
    expect(composed(base, { ...context(), mode: 'assembled' }).notices[0]?.reason).toContain(
      'no table was published',
    );
  });
  it('bounds notices and reports the omitted item count', () => {
    const text = boundedNotice(
      'Not delivered: ',
      Array.from({ length: 20 }, (_, i) => `${i} ${'x'.repeat(200)}`),
    );
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toMatch(/\(\+18 more\)$/u);
  });
});
