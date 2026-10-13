import { describe, expect, it } from 'vitest';

import {
  checkAnchoring,
  digitGroups,
  isAnchored,
  normalizeEvidence,
  numbersMissing,
} from '../../src/synthesis/anchoring.js';
describe('@no-llm evidence anchoring', () => {
  it('normalizes Unicode, whitespace and grouped prices', () => {
    expect(normalizeEvidence(' ＡＷＤ  \n ４３２０４ ')).toBe('awd 43204');
    expect([...digitGroups('$43,204')]).toEqual(['43204']);
    expect(numbersMissing('$43,204', 'Price 43204')).toEqual([]);
    expect(numbersMissing('$41,000', 'Price 43204')).toEqual(['41000']);
    expect(numbersMissing('４３２０４', '43204')).toEqual([]);
  });
  it('uses the shared content-word overlap rule', () => {
    expect(isAnchored('Calligraphy AWD', 'calligraphy trim, all-wheel drive (AWD)')).toBe(true);
    expect(isAnchored('', '')).toBe(true);
    expect(isAnchored('Imaginary submarine', 'Calligraphy AWD')).toBe(false);
  });
  it('flags unsupported values, treating null evidence as empty', () => {
    const result = checkAnchoring(
      [
        {
          id: 'cell/0',
          kind: 'cell',
          text: '$43,204',
          refs: ['S1', 'S2'],
          mode: 'numbers-and-words',
        },
        { id: 'cell/1', kind: 'cell', text: '$41,000', refs: ['S2'], mode: 'numbers' },
        { id: 'empty', kind: 'finding', text: '', refs: [], mode: 'numbers-and-words' },
      ],
      (ref) => (ref === 'S1' ? 'Price 43204' : null),
    );
    expect(result.checked).toBe(3);
    expect(result.flagged).toEqual([
      { id: 'cell/1', kind: 'cell', text: '$41,000', missing: ['41000'] },
    ]);
  });
});
