import { validateBrief } from '@yantra/protocol';
import { canonicalBrief, makeBrief } from '@yantra/test-helpers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { briefToMarkdown } from '../../src/brief/to-markdown.js';

import { briefArb } from './arbitraries.js';

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

describe('@no-llm briefToMarkdown', () => {
  it('renders the canonical Brief to a stable full-detail document', () => {
    // Arrange / Act
    const md = briefToMarkdown(canonicalBrief);

    // Assert
    expect(md).toMatchSnapshot();
  });

  it('opens with the title as an H1 and the overview as a blockquote', () => {
    const md = briefToMarkdown(canonicalBrief);

    expect(md.startsWith('# Cheapest Sony WH-1000XM5 today\n')).toBe(true);
    expect(md).toContain('> Lowest price is **$328** at Amazon');
  });

  it('marks uncited editorial findings and keeps cited findings unmarked', () => {
    const md = briefToMarkdown(canonicalBrief);

    expect(md).toContain('- Amazon — $328, in stock, free shipping [1]');
    expect(md).toContain(
      '- Prices have trended upward since last week, so buying now is reasonable. *(editorial)*',
    );
    // A cited finding never carries the editorial marker.
    expect(md).not.toContain('free shipping [1] *(editorial)*');
  });

  it('renders the comparison facet as a GitHub Markdown table with ✓/✗ booleans', () => {
    const md = briefToMarkdown(canonicalBrief);

    expect(md).toContain('## Comparison');
    expect(md).toContain('| Retailer | Price | In stock |');
    expect(md).toContain('| --- | --- | --- |');
    expect(md).toContain('| Amazon | $328 | ✓ |');
  });

  it('renders sources as a numbered link list with fetched and published dates', () => {
    const md = briefToMarkdown(canonicalBrief);

    expect(md).toContain('## Sources');
    expect(md).toContain(
      '1. [Sony WH-1000XM5 Wireless Headphones — Amazon](https://www.amazon.com/sony-wh-1000xm5) — ' +
        'amazon.com · fetched 2026-07-01T09:00:00.000Z · published 2026-06-28T00:00:00.000Z',
    );
    // Best Buy has no published date — the meta list omits it.
    expect(md).toContain(
      '2. [Sony WH-1000XM5 | Best Buy](https://www.bestbuy.com/sony-wh-1000xm5) — ' +
        'bestbuy.com · fetched 2026-07-01T09:00:05.000Z',
    );
  });

  it('omits the Comparison heading when facets are null', () => {
    const md = briefToMarkdown(makeBrief({ facets: null }));

    expect(md).not.toContain('## Comparison');
  });

  it('omits section headings when there are no sections', () => {
    const md = briefToMarkdown(makeBrief({ sections: [] }));

    // Only the structural headings remain — no stray detail section.
    expect(md).not.toContain('## Price & availability');
    expect(md).not.toContain('## Caveats');
  });

  it('renders a Notices section only when notices are present', () => {
    const withNotice = briefToMarkdown(
      makeBrief({
        notices: [{ source: 'slow.example.com', reason: 'fetch timed out', kind: 'fetch_failed' }],
      }),
    );
    const withoutNotice = briefToMarkdown(makeBrief({ notices: [] }));

    expect(withNotice).toContain('## Notices');
    expect(withNotice).toContain('- **fetch_failed** — slow.example.com: fetch timed out');
    expect(withoutNotice).not.toContain('## Notices');
  });

  it('is deterministic — identical input yields identical bytes', () => {
    expect(briefToMarkdown(canonicalBrief)).toBe(briefToMarkdown(canonicalBrief));
  });

  it('never emits ANSI escape bytes for any schema-valid Brief', () => {
    fc.assert(
      fc.property(briefArb(), (brief) => {
        // Guard: the arbitrary must only produce schema-valid Briefs.
        expect(validateBrief(brief).isOk).toBe(true);

        const md = briefToMarkdown(brief);
        expect(md.includes(ESC)).toBe(false);
        expect(md.includes(CSI)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('appends capped citation markers to a finding with structured citations', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      n: i + 1,
      url: `https://s${i + 1}.example.com/page`,
      final_url: null,
      host: `s${i + 1}.example.com`,
      title: `Source ${i + 1}`,
      excerpt: null,
      fetched_at: '2026-07-01T10:00:00.000Z',
      published_at: null,
    }));
    const md = briefToMarkdown(
      makeBrief({
        sources,
        overview: 'Answer first.',
        key_findings: [
          {
            text: 'A widely reported claim.',
            citations: [1, 2, 3, 4, 5],
            editorial: false,
            facet: null,
          },
        ],
      }),
    );
    expect(md).toContain('- A widely reported claim. [1][2][3] (+2)');
  });

  it('caps inline [n] runs in the overview to the same budget', () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      n: i + 1,
      url: `https://s${i + 1}.example.com/page`,
      final_url: null,
      host: `s${i + 1}.example.com`,
      title: `Source ${i + 1}`,
      excerpt: null,
      fetched_at: '2026-07-01T10:00:00.000Z',
      published_at: null,
    }));
    const md = briefToMarkdown(
      makeBrief({
        sources,
        overview: 'Corroborated everywhere. [1][2][3][4][5]',
        key_findings: [],
      }),
    );
    expect(md).toContain('[1][2][3] (+2)');
    expect(md).not.toContain('[4]');
  });

  it('preserves GFM key-figures table lines', () => {
    const table =
      '| Figure | Context | Sources |\n| --- | --- | --- |\n| 48 teams | Expanded field | [1] |';
    const md = briefToMarkdown(
      makeBrief({ sections: [{ heading: 'Key facts', body_md: table, citations: [1] }] }),
    );
    expect(md).toContain(table);
  });
});
