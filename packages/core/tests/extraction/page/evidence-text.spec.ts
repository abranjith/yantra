import { describe, expect, it } from 'vitest';

import {
  pageEvidenceText,
  recordEvidenceText,
} from '../../../src/extraction/page/evidence-text.js';
import type { PageAnalysis, PageRecord } from '../../../src/extraction/page/types.js';
const record: PageRecord = {
  key: 'one',
  title: 'Calligraphy',
  url: null,
  segments: ['AWD'],
  fields: [{ label: 'Price', value: '43204' }],
  numbers: [{ kind: 'currency', text: '$43,204', value: 43204 }],
  links: [{ text: 'Seller', url: 'https://seller.test/' }],
};
describe('@no-llm stored evidence text', () => {
  const page: PageAnalysis = {
    shape: 'collection',
    records: [record],
    readableText: 'Read me',
    fields: [{ label: 'Color', value: 'Blue' }],
    tables: [{ index: 0, kind: 'data', caption: 'Prices', headers: ['Price'], rows: [['50']] }],
    structured: [
      { type: 'Product', from: 'json-ld', props: { name: 'Special', 'offers.price': 60 } },
    ],
    links: [],
    recordLinkCount: 0,
    coverage: { shape_basis: 'test', fetch_mode: 'http', not_found: [], omitted: [] },
  };
  it('includes record labels, numeric spans and link text', () =>
    expect(recordEvidenceText(record)).toBe('Calligraphy\nAWD\nPrice: 43204\n$43,204\nSeller'));
  it('includes table cells and structured properties', () => {
    const text = pageEvidenceText(page, 'Title');
    for (const part of ['Title', 'Read me', 'Color: Blue', 'Prices', '50', 'Special', '60'])
      expect(text).toContain(part);
  });
  it('caps its runtime-only corpus', () =>
    expect(pageEvidenceText({ ...page, readableText: 'x'.repeat(250000) }, null)).toHaveLength(
      200000,
    ));
});
