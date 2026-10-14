import { describe, expect, it, vi } from 'vitest';

import {
  checkAnchoring,
  digitGroups,
  isAnchored,
  normalizeEvidence,
  numbersMissing,
} from '../../src/synthesis/anchoring.js';
describe('@no-llm evidence anchoring', () => {
  it.each([
    ['45000', '$45,000.00', []],
    ['45000', '$450.00', ['45000']],
    ['-450.50', '$450.50', ['-450.5']],
    ['+450.50', '$450.5', []],
    ['450', '450,00', ['450']],
    ['45000', '45.000,00', ['45000']],
    ['001.2500', '1.25', []],
    ['.50', '0.5', []],
    ['.50', '50', ['0.5']],
    ['-.50', '-$0.50', []],
    ['-$450.50', '$450.50', ['-450.5']],
  ])('compares %s with %s without changing magnitude', (claim, evidence, missing) => {
    expect(numbersMissing(claim, evidence)).toEqual(missing);
  });
  it('prepares each source once for 600 cells, including equivalent reference groups', () => {
    const evidenceFor = vi.fn(() => 'Glacier White Price 45000 '.repeat(8000));
    const claims = Array.from({ length: 600 }, (_, index) => ({
      id: String(index),
      kind: 'cell' as const,
      text: 'Glacier White 45000',
      refs: index % 2 === 0 ? ['S1', 'S2'] : ['S2', 'S1', 'S1'],
      mode: 'numbers-and-words' as const,
    }));
    expect(checkAnchoring(claims, evidenceFor)).toEqual({ checked: 600, flagged: [] });
    expect(evidenceFor).toHaveBeenCalledTimes(2);
  });
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
