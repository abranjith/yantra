import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateBrief } from '../src/index.js';

import { mutatedBriefArb, validBriefArb } from './arbitraries/brief.js';

describe('@no-llm brief property-based validation', () => {
  it('accepts every structurally consistent generated Brief', () => {
    fc.assert(
      fc.property(validBriefArb(), (brief) => {
        const result = validateBrief(brief);
        if (!result.isOk) {
          throw new Error(`expected ok, got: ${result.error.message}`);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('rejects every corrupted Brief with at least one actionable path — never throws', () => {
    fc.assert(
      fc.property(mutatedBriefArb, ({ brief, corruption }) => {
        const result = validateBrief(brief);
        if (result.isOk) {
          throw new Error(`corruption '${corruption}' was not rejected`);
        }

        expect(result.error.issues.length).toBeGreaterThan(0);
        expect(result.error.issues.some((issue) => issue.path.length > 0)).toBe(true);
        result.error.issues.forEach((issue) => {
          expect(issue.message.length).toBeGreaterThan(0);
        });
      }),
      { numRuns: 500 },
    );
  });

  it('never throws on arbitrary garbage input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        expect(() => validateBrief(raw)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
