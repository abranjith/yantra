import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Brief } from '../src/index.js';

import { makeBrief, makeSource } from './brief-factories.js';

function attributed() {
  return makeBrief({
    sources: [makeSource(1, { cited: true }), makeSource(2, { cited: false })],
    facets: { comparison: { columns: ['Price'], rows: [[10]], row_citations: [[1]] } },
    constraints: [{ name: 'drivetrain', value: 'AWD', status: 'verified', citations: [1] }],
    sections: [
      { heading: 'Alternatives', kind: 'alternatives', body_md: 'Other options', citations: [] },
    ],
    notices: [{ source: 'task-contract', kind: 'contract_gap', reason: 'Not delivered' }],
  });
}

describe('@no-llm attributed Brief integrity', () => {
  it('accepts every additive field', () =>
    expect(Brief.safeParse(attributed()).success).toBe(true));
  it.each([
    [
      'row length',
      'facets/comparison/row_citations',
      (b: ReturnType<typeof attributed>) => {
        b.facets!.comparison!.row_citations = [];
      },
    ],
    [
      'dangling row',
      'facets/comparison/row_citations/0/0',
      (b: ReturnType<typeof attributed>) => {
        b.facets!.comparison!.row_citations = [[9]];
      },
    ],
    [
      'dangling constraint',
      'constraints/0/citations/0',
      (b: ReturnType<typeof attributed>) => {
        b.constraints![0]!.citations = [9];
      },
    ],
    [
      'mixed classification',
      'sources/1/cited',
      (b: ReturnType<typeof attributed>) => {
        delete b.sources[1]!.cited;
      },
    ],
    [
      'classification order',
      'sources/1/cited',
      (b: ReturnType<typeof attributed>) => {
        b.sources[0]!.cited = false;
        b.sources[1]!.cited = true;
      },
    ],
    [
      'consulted finding',
      'key_findings/0/citations/0',
      (b: ReturnType<typeof attributed>) => {
        b.key_findings[0]!.citations = [2];
      },
    ],
    [
      'unsupported verification',
      'constraints/0/citations',
      (b: ReturnType<typeof attributed>) => {
        b.constraints![0]!.citations = [];
      },
    ],
  ] as const)('rejects %s at its precise pointer', (_, pointer, change) => {
    const brief = attributed();
    change(brief);
    const result = Brief.safeParse(brief);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path.join('/'))).toContain(pointer);
  });
  it('rejects unknown section kinds', () => {
    expect(
      Brief.safeParse({
        ...attributed(),
        sections: [{ heading: 'x', body_md: '', citations: [], kind: 'unknown' }],
      }).success,
    ).toBe(false);
  });
  it('validates consistent optional fields and their removal', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 100 }), { maxLength: 20 }), (values) => {
        const brief = attributed();
        brief.facets!.comparison!.rows = values.map((value) => [value]);
        brief.facets!.comparison!.row_citations = values.map(() => [1]);
        expect(Brief.safeParse(brief).success).toBe(true);
        delete brief.facets!.comparison!.row_citations;
        delete brief.constraints;
        brief.sources.forEach((source) => {
          delete source.cited;
        });
        delete brief.sections[0]!.kind;
        expect(Brief.safeParse(brief).success).toBe(true);
      }),
    );
  });
});
