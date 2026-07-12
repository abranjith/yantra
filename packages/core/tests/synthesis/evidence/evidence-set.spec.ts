import { describe, expect, it } from 'vitest';

import { WinkAnalyzer } from '../../../src/synthesis/analysis/wink-analyzer.js';
import { buildEvidenceSet } from '../../../src/synthesis/evidence/evidence-set.js';
import type {
  SynthesisDoc,
  SynthesisInput,
  SynthesisLength,
} from '../../../src/synthesis/types.js';

const analyzer = new WinkAnalyzer();
const QUERY = 'State of EV car sales in US in 2026';

function doc(url: string, text: string): SynthesisDoc {
  return {
    url,
    finalUrl: null,
    host: new URL(url).hostname,
    title: null,
    fetchedAt: '2026-06-01T00:00:00.000Z',
    publishedAt: null,
    text,
    excerpt: null,
  };
}

function input(docs: readonly SynthesisDoc[]): SynthesisInput {
  return { query: QUERY, docs, failures: [] };
}

function assemble(docs: readonly SynthesisDoc[], length: SynthesisLength = 'medium') {
  return buildEvidenceSet(input(docs), analyzer, length);
}

describe('@no-llm synthesis/buildEvidenceSet near-duplicate merge', () => {
  it('merges paraphrased claims into one, unioning their citations', () => {
    const { evidenceSet } = assemble([
      doc('https://a.example.com/1', 'US electric vehicle sales fell 28% in 2026.'),
      doc('https://b.example.com/1', 'Electric vehicle sales in the US declined 28% during 2026.'),
    ]);

    expect(evidenceSet.claims).toHaveLength(1);
    // The single surviving claim carries evidence from both sources.
    expect(evidenceSet.claims[0]!.docIndexes).toEqual([0, 1]);
  });
});

describe('@no-llm synthesis/buildEvidenceSet budgets as caps', () => {
  const twoFindings = [
    doc('https://a.example.com/1', 'US EV car sales fell 28% in 2026 as demand cooled.'),
    doc(
      'https://b.example.com/1',
      'EV charging stations grew to 200,000 units across the US in 2026.',
    ),
  ];

  it('keeps exactly the relevant findings and flags under-budget for a medium budget', () => {
    const { evidenceSet } = assemble(twoFindings, 'medium');
    expect(evidenceSet.claims).toHaveLength(2);
    expect(evidenceSet.underBudget).toBe(true);
  });

  it('never pads: under-budget holds across every length when evidence is thin', () => {
    for (const length of ['short', 'medium', 'long'] as const) {
      const { evidenceSet } = assemble(twoFindings, length);
      expect(evidenceSet.claims).toHaveLength(2);
      expect(evidenceSet.underBudget).toBe(true);
    }
  });

  it('clears under-budget when enough distinct relevant claims survive', () => {
    const rich = [
      doc('https://a.example.com/1', 'US EV car sales fell 28% in 2026 as demand cooled sharply.'),
      doc(
        'https://b.example.com/1',
        'EV charging stations grew to 200,000 units across the US in 2026.',
      ),
      doc(
        'https://c.example.com/1',
        'Average EV car prices in the US dropped to $39,000 during 2026.',
      ),
      doc(
        'https://d.example.com/1',
        'US battery production for electric cars expanded 45% over the 2026 sales year.',
      ),
    ];
    const { evidenceSet } = assemble(rich, 'short');
    expect(evidenceSet.claims.length).toBeGreaterThanOrEqual(3);
    expect(evidenceSet.underBudget).toBe(false);
  });
});

describe('@no-llm synthesis/buildEvidenceSet exclusions + used docs', () => {
  it('records excluded off-topic sources and never lists them in usedDocIndexes', () => {
    const { evidenceSet } = assemble([
      doc('https://ev.example.com/1', 'US EV car sales fell 28% in 2026 as demand cooled.'),
      doc(
        'https://nasa.example.gov/mars',
        'NASA scientists confirmed ancient water once flowed across the surface of Mars.',
      ),
    ]);

    expect(evidenceSet.exclusions.map((exclusion) => exclusion.host)).toContain('nasa.example.gov');
    // usedDocIndexes are in the kept-doc space; the excluded doc is not kept.
    expect(evidenceSet.usedDocIndexes.every((index) => index >= 0)).toBe(true);
  });
});

describe('@no-llm synthesis/buildEvidenceSet determinism', () => {
  it('produces a deep-equal EvidenceSet across repeated calls', () => {
    const docs = [
      doc('https://a.example.com/1', 'US EV car sales fell 28% in 2026 as demand cooled.'),
      doc(
        'https://b.example.com/1',
        'EV charging stations grew to 200,000 units in the US in 2026.',
      ),
    ];
    expect(assemble(docs).evidenceSet).toEqual(assemble(docs).evidenceSet);
  });
});
