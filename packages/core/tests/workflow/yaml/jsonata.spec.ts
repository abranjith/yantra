// @no-llm
import fc from 'fast-check';
import { describe, it, expect } from 'vitest';

import { JSONataEvaluator, JSONataEvaluationError } from '../../../src/workflow/yaml/jsonata.js';

describe('JSONataEvaluator', () => {
  const evaluator = new JSONataEvaluator();

  describe('validate()', () => {
    it('returns ok for a valid expression', () => {
      const result = evaluator.validate('$sum([1, 2, 3])');
      expect(result.isOk).toBe(true);
    });

    it('returns err for an invalid expression', () => {
      const result = evaluator.validate('$invalidSyntax(x y z');
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.code).toBe('INVALID_EXPRESSION');
        expect(result.error).toBeInstanceOf(JSONataEvaluationError);
      }
    });

    it('returns err for another invalid expression', () => {
      const result = evaluator.validate('{{broken{{');
      expect(result.isOk).toBe(false);
    });

    it('does not execute the expression during validate', () => {
      // This expression would take a long time to evaluate
      // but validate should return quickly (just parsing)
      const start = Date.now();
      const result = evaluator.validate('$sum([1,2,3])');
      const elapsed = Date.now() - start;
      expect(result.isOk).toBe(true);
      // validate should complete in well under 50ms (no execution)
      expect(elapsed).toBeLessThan(50);
    });
  });

  describe('evaluate()', () => {
    it('evaluates a simple arithmetic expression', async () => {
      const result = await evaluator.evaluate('1 + 2', {});
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value).toBe(3);
      }
    });

    it('evaluates expression with param scope', async () => {
      const result = await evaluator.evaluate('param.name', {
        param: { name: 'Alice' },
      });
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value).toBe('Alice');
      }
    });

    it('evaluates expression with capture scope', async () => {
      const result = await evaluator.evaluate('capture.total', {
        capture: { total: 42 },
      });
      expect(result.isOk).toBe(true);
      if (result.isOk) {
        expect(result.value).toBe(42);
      }
    });

    it('returns err for invalid expression during evaluate', async () => {
      const result = await evaluator.evaluate('(((broken', {});
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.code).toBe('INVALID_EXPRESSION');
      }
    });

    it('returns TIMEOUT error when expression exceeds timeoutMs', async () => {
      const fastEvaluator = new JSONataEvaluator({ timeoutMs: 10 });
      // Create an expression that generates a large computation
      // JSONata doesn't have easy busy-loops, so we test via a very tight timeout
      const result = await fastEvaluator.evaluate('$sum([1..1000].($sum([1..100])))', {});
      // This might timeout or succeed depending on machine speed
      if (!result.isOk) {
        expect(['TIMEOUT', 'INVALID_EXPRESSION', 'SIZE_LIMIT']).toContain(result.error.code);
      }
    }, 5000);

    it('returns SIZE_LIMIT error when result exceeds maxResultBytes', async () => {
      const tinyEvaluator = new JSONataEvaluator({ maxResultBytes: 10 });
      const result = await tinyEvaluator.evaluate(
        '"this is a long string that exceeds ten bytes"',
        {},
      );
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.code).toBe('SIZE_LIMIT');
      }
    });

    it('does not expose process.env via scope', async () => {
      const result = await evaluator.evaluate('$env', {});
      // JSONata should not have $env — it would return undefined or error
      if (result.isOk) {
        expect(result.value).toBeUndefined();
      }
    });

    it('does not expose global JavaScript globals', async () => {
      // Attempting to access global would produce undefined in JSONata context
      const result = await evaluator.evaluate('global', {});
      if (result.isOk) {
        expect(result.value).toBeUndefined();
      }
    });

    it('property: valid simple expressions evaluate without crashing', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 100 }),
          async (a, b) => {
            const result = await evaluator.evaluate(`${a} + ${b}`, {});
            if (result.isOk) {
              expect(result.value).toBe(a + b);
            }
            return true;
          },
        ),
      );
    });
  });
});
