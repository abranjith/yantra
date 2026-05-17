/**
 * @no-llm Smoke tests verifying the agent barrel exports.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUDGET,
  NullLLMClient,
  assertSanitized,
  brandSanitized,
  createLLMClient,
  estimateCostUsd,
  resolveUserFacingHint,
  wrapWithAudit,
  InMemoryAuditWriter,
  InMemoryUsageWriter,
} from '../src/index.js';

describe('@yantra/agent barrel exports', () => {
  it('NullLLMClient is exported and functional', () => {
    const client = new NullLLMClient();
    expect(client.providerId).toBe('null');
  });

  it('createLLMClient returns NullLLMClient for provider=none', () => {
    const client = createLLMClient({ provider: 'none', defaultBudget: DEFAULT_BUDGET });
    expect(client).toBeInstanceOf(NullLLMClient);
  });

  it('brandSanitized + assertSanitized work end-to-end', () => {
    const s = brandSanitized('test string');
    expect(() => assertSanitized(s)).not.toThrow();
  });

  it('wrapWithAudit returns an LLMClient', () => {
    const inner = new NullLLMClient();
    const audit = new InMemoryAuditWriter();
    const usage = new InMemoryUsageWriter();
    const wrapped = wrapWithAudit(inner, audit, usage, 'run-001');
    expect(wrapped.providerId).toBe('null');
  });

  it('estimateCostUsd returns null for unknown model', () => {
    expect(estimateCostUsd('unknown-model', 100, 50)).toBeNull();
  });

  it('estimateCostUsd returns number for known model', () => {
    const cost = estimateCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000);
    expect(cost).not.toBeNull();
    expect(typeof cost).toBe('number');
    expect(cost!).toBeGreaterThan(0);
  });

  it('resolveUserFacingHint returns a non-empty string for any code', () => {
    expect(resolveUserFacingHint('unknown_locator').length).toBeGreaterThan(5);
    expect(resolveUserFacingHint(null).length).toBeGreaterThan(5);
  });
});
