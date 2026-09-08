import { describe, expect, it } from 'vitest';

import { configSchema } from '../../src/config/schema.js';

describe('@no-llm configSchema', () => {
  it('defaults every field from an empty object', () => {
    expect(configSchema.parse({})).toMatchObject({
      version: 1,
      paths: { data_dir: null, cache_dir: null },
      models: [],
      retention: { runs_days: 30, corrupt_index_keep: 3 },
    });
  });

  it('rejects duplicate provider and id pairs', () => {
    const model = { id: 'same', provider: 'anthropic' };
    expect(configSchema.safeParse({ models: [model, model] }).success).toBe(false);
  });

  it('requires a base URL for a local or custom provider', () => {
    const result = configSchema.safeParse({ models: [{ id: 'llama', provider: 'ollama' }] });
    expect(result.success).toBe(false);
  });

  it('rejects literal credentials with an actionable command', () => {
    const result = configSchema.safeParse({
      models: [{ id: 'claude', provider: 'anthropic', api_key: 'canary-secret' }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('yantra secret set');
  });
});
