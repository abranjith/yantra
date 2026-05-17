/**
 * @no-llm Tests for NullLLMClient.
 */
import { describe, expect, it } from 'vitest';

import { NullLLMClient } from '../../src/client/null.js';
import { makeGeneratePlanOpts, makeSummarizeOpts } from '../factories.js';

describe('NullLLMClient', () => {
  const client = new NullLLMClient();

  it('providerId is "null"', () => {
    expect(client.providerId).toBe('null');
  });

  describe('generatePlan', () => {
    it('returns LLMUnavailable with provider_none reason', async () => {
      const result = await client.generatePlan(makeGeneratePlanOpts());
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.kind).toBe('llm_unavailable');
        if (result.error.kind === 'llm_unavailable') {
          expect(result.error.reason).toBe('provider_none');
          expect(result.error.hint).toContain('yantra doctor');
        }
      }
    });

    it('returns immediately without I/O', async () => {
      const start = Date.now();
      await client.generatePlan(makeGeneratePlanOpts());
      expect(Date.now() - start).toBeLessThan(100);
    });
  });

  describe('summarize', () => {
    it('returns LLMUnavailable with provider_none reason', async () => {
      const result = await client.summarize(makeSummarizeOpts());
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.kind).toBe('llm_unavailable');
      }
    });
  });
});
