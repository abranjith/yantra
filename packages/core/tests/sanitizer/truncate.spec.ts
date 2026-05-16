import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { TRUNCATION_MARKER, truncateUtf8 } from '../../src/sanitizer/truncate.js';

const DECODER = new TextDecoder('utf-8', { fatal: true });

describe('@no-llm truncateUtf8', () => {
  it('does not truncate when text fits the budget', () => {
    const result = truncateUtf8('hello', 100);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe('hello');
  });

  it('appends the marker when text exceeds the budget', () => {
    const result = truncateUtf8('hello world', 2);
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('property: truncation never returns invalid UTF-8 and remains budget-bounded', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 8192 }), (input, budget) => {
        const result = truncateUtf8(input, budget);
        const encoded = Buffer.from(result.text, 'utf8');

        expect(() => DECODER.decode(encoded)).not.toThrow();

        const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
        expect(encoded.length).toBeLessThanOrEqual(budget + markerBytes);
      }),
      { numRuns: 400 },
    );
  });
});
