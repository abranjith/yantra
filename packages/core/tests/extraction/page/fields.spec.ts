import { describe, expect, it } from 'vitest';

import {
  LABEL_MAX,
  MAX_FIELDS,
  VALUE_MAX,
  parseLabelValue,
} from '../../../src/extraction/page/fields.js';

import { analyzeWithoutArticle, documentWith, extractPage, pageFixture } from './helpers.js';

describe('@no-llm extraction/page/fields', () => {
  it('reads a detail page with a 12-row attribute table as detail, colors included', async () => {
    const page = await extractPage(
      pageFixture('detail-attributes.html'),
      'https://rv.test/units/21',
    );
    expect(page.shape).toBe('detail');
    expect(page.fields).toContainEqual({ label: 'Exterior color', value: 'Desert Tan' });
    expect(page.fields).toContainEqual({ label: 'Interior color', value: 'Charcoal Gray' });
    expect(page.coverage.fields).toEqual({ found: 12, shown: 12 });
    expect(page.coverage.shape_basis).toMatch(/^detail: 12 label\/value fields/u);
  });

  it('reads dl pairs, joining several dd values and looking through div groups', () => {
    const html = documentWith(
      '<dl><dt>Colors</dt><dd>Red</dd><dd>Blue</dd><div><dt>Size:</dt><dd>Large</dd></div><dt>Empty</dt></dl>',
    );
    expect(analyzeWithoutArticle(html).fields).toEqual([
      { label: 'Colors', value: 'Red, Blue' },
      { label: 'Size', value: 'Large' },
    ]);
  });

  it('reads "Label: value" lines outside landmarks only', () => {
    const html = documentWith(
      '<nav><p>Menu: Home</p></nav><main><p>Weight: 12 kg</p><p>This whole line is a sentence: not a field, its label has six words</p></main>',
    );
    expect(analyzeWithoutArticle(html).fields).toEqual([{ label: 'Weight', value: '12 kg' }]);
  });

  it('keeps a repeated label+value pair once, case-insensitively', () => {
    const html = documentWith(
      '<p>Color: Red</p><dl><dt>color</dt><dd>red</dd></dl><p>Color: Blue</p>',
    );
    expect(analyzeWithoutArticle(html).fields).toEqual([
      { label: 'color', value: 'red' },
      { label: 'Color', value: 'Blue' },
    ]);
  });

  it('bounds page fields at MAX_FIELDS and records the omission', () => {
    const lines = Array.from({ length: 70 }, (_, n) => `<p>Attribute ${n}: value ${n}</p>`).join(
      '',
    );
    const page = analyzeWithoutArticle(documentWith(lines));
    expect(page.fields).toHaveLength(MAX_FIELDS);
    expect(page.coverage.fields).toEqual({ found: 70, shown: MAX_FIELDS });
    expect(page.coverage.omitted).toContainEqual({ id: 'fields-beyond-limit', count: 10 });
  });

  it('cuts labels and values at their bounds', () => {
    const html = documentWith(
      `<dl><dt>${'L'.repeat(10)} ${'abc '.repeat(20)}</dt><dd>${'value '.repeat(60)}</dd></dl>`,
    );
    const [field] = analyzeWithoutArticle(html).fields;
    expect(field?.label.length).toBeLessThanOrEqual(LABEL_MAX);
    expect(field?.value.length).toBeLessThanOrEqual(VALUE_MAX);
  });

  describe('parseLabelValue', () => {
    it.each([
      ['Exterior color: Glacier White', { label: 'Exterior color', value: 'Glacier White' }],
      ['Price: $1,200', { label: 'Price', value: '$1,200' }],
      ['A label with far too many words here: value', null],
      ['https: //example', null],
      ['10: 30', null],
      ['Label:value without a space', null],
      ['No colon at all', null],
      [`${'x'.repeat(41)}: v`, null],
    ])('%s', (run, expected) => {
      expect(parseLabelValue(run)).toEqual(expected);
    });
  });
});
