import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ExtractionResultEnvelopeUnknown,
  filterValidExtractionRows,
  extractionResultEnvelope,
} from '../src/index.js';

describe('@no-llm extraction envelope', () => {
  it('accepts matching metadata totals', () => {
    const schema = extractionResultEnvelope(z.object({ amount: z.number() }));

    const result = schema.safeParse({
      rows: [{ amount: 1 }],
      metadata: { total_rows: 1, valid_rows: 1, error_count: 0 },
    });

    expect(result.success).toBe(true);
  });

  it('enforces total_rows = valid_rows + error_count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (valid, error) => {
          const total = valid + error;
          const candidate = {
            rows: Array.from({ length: total }, (_, index) =>
              index < valid ? { value: index } : { __error: 'bad', __raw: index },
            ),
            metadata: { total_rows: total, valid_rows: valid, error_count: error },
          };

          expect(ExtractionResultEnvelopeUnknown.safeParse(candidate).success).toBe(true);
          expect(
            ExtractionResultEnvelopeUnknown.safeParse({
              ...candidate,
              metadata: { ...candidate.metadata, total_rows: total + 1 },
            }).success,
          ).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('filters error rows from mixed row arrays', () => {
    const rows = [{ value: 1 }, { __error: 'x', __raw: 2 }, { value: 3 }];
    expect(filterValidExtractionRows(rows)).toEqual([{ value: 1 }, { value: 3 }]);
  });
});
