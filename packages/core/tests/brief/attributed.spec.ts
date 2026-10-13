import { makeBrief, makeSource } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { briefToHtml } from '../../src/brief/to-html.js';
import { briefToMarkdown } from '../../src/brief/to-markdown.js';

const brief = makeBrief({
  title: 'Attributed results',
  key_findings: [],
  sources: [makeSource(1, { cited: true }), makeSource(2, { cited: false })],
  facets: {
    comparison: { columns: ['Seller', 'Price'], rows: [['A | B', 100]], row_citations: [[1]] },
  },
  constraints: [
    { name: 'drivetrain', value: 'AWD', status: 'verified', citations: [1] },
    { name: 'location', value: '<img onerror=x>', status: 'unverified', citations: [] },
  ],
  sections: [
    { heading: 'Alternatives', kind: 'alternatives', body_md: 'Other options [1]', citations: [1] },
  ],
});

describe('@no-llm attributed renderers', () => {
  it('renders conditions, row citations and separate consulted sources', () => {
    const md = briefToMarkdown(brief);
    expect(md).toContain('**Conditions:** drivetrain = AWD ✓ verified [1]');
    expect(md).toContain('| Seller | Price | Sources |');
    expect(md).toContain('| A \\| B | 100 | [1] |');
    expect(md).toContain('## Also consulted');
    expect(md).toMatchSnapshot();
  });
  it('renders escaped inert HTML and preserves source anchors', () => {
    const html = briefToHtml(brief);
    expect(html).toContain('class="constraints"');
    expect(html).toContain('<th>Sources</th>');
    expect(html).toContain('id="src-2"');
    expect(html).toContain('Also consulted');
    expect(html).not.toMatch(/<script|<[^>]+\son\w+=/u);
    expect(html).toMatchSnapshot();
  });
  it('omits Sources when every source is consulted', () => {
    const all = makeBrief({
      key_findings: [],
      overview: '',
      sources: [makeSource(1, { cited: false })],
    });
    expect(briefToMarkdown(all)).not.toContain('## Sources');
    expect(briefToHtml(all)).not.toContain('<h2>Sources</h2>');
    expect(briefToMarkdown(all)).toContain('## Also consulted');
  });
});
