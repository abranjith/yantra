/**
 * @no-llm Tests for the wrapWithAudit higher-order function.
 */
import { describe, expect, it } from 'vitest';

import { InMemoryAuditWriter, InMemoryUsageWriter, wrapWithAudit } from '../../src/audit/wrap.js';
import { NullLLMClient } from '../../src/client/null.js';
import { makeGeneratePlanOpts, makeSummarizeOpts } from '../factories.js';

describe('wrapWithAudit()', () => {
  function makeWrapped() {
    const inner = new NullLLMClient();
    const audit = new InMemoryAuditWriter();
    const usage = new InMemoryUsageWriter();
    const wrapped = wrapWithAudit(inner, audit, usage, 'run-test-001');
    return { inner, audit, usage, wrapped };
  }

  describe('providerId', () => {
    it('delegates to inner client', () => {
      const { wrapped } = makeWrapped();
      expect(wrapped.providerId).toBe('null');
    });
  });

  describe('generatePlan', () => {
    it('emits exactly 2 audit entries (request + response) on error', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.generatePlan(makeGeneratePlanOpts());
      expect(audit.entries).toHaveLength(2);
      expect(audit.entries[0]?.direction).toBe('request');
      expect(audit.entries[1]?.direction).toBe('response');
    });

    it('request entry has task_id and run_id', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.generatePlan(makeGeneratePlanOpts({ taskId: 'task-abc', runId: 'run-xyz' }));
      expect(audit.entries[0]?.task_id).toBe('task-abc');
      expect(audit.entries[0]?.run_id).toBe('run-xyz');
    });

    it('response entry has provider_id', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.generatePlan(makeGeneratePlanOpts());
      expect(audit.entries[1]?.provider_id).toBe('null');
    });

    it('does NOT append to usage on failure (NullLLMClient always fails)', async () => {
      const { wrapped, usage } = makeWrapped();
      await wrapped.generatePlan(makeGeneratePlanOpts());
      expect(usage.calls).toHaveLength(0);
    });

    it('propagates the underlying result unchanged', async () => {
      const { wrapped } = makeWrapped();
      const result = await wrapped.generatePlan(makeGeneratePlanOpts());
      expect(result.isOk).toBe(false);
      if (!result.isOk) {
        expect(result.error.kind).toBe('llm_unavailable');
      }
    });

    it('response entry outcome is provider_error for unavailable provider', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.generatePlan(makeGeneratePlanOpts());
      expect(audit.entries[1]?.outcome).toBe('provider_error');
    });
  });

  describe('summarize', () => {
    it('emits exactly 2 audit entries on error', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.summarize(makeSummarizeOpts());
      expect(audit.entries).toHaveLength(2);
    });

    it('passes stepId through to audit entries', async () => {
      const { wrapped, audit } = makeWrapped();
      await wrapped.summarize(makeSummarizeOpts({ stepId: 'step-s3' }));
      expect(audit.entries[0]?.step_id).toBe('step-s3');
    });
  });
});
