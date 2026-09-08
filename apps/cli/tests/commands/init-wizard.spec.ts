import { describe, expect, it, vi } from 'vitest';

import { runInitWizard } from '../../src/commands/init-wizard.js';

describe('@no-llm init wizard', () => {
  it('collects provider, env reference, model, and storage in order', async () => {
    const selections = ['anthropic', 'environment variable'];
    const texts = ['ANTHROPIC_API_KEY', 'claude-custom', 'D:\\yantra-data'];
    const result = await runInitWizard({
      select: async () => selections.shift() ?? null,
      text: async () => texts.shift() ?? null,
    });
    expect(result).toEqual({
      provider: 'anthropic',
      modelId: 'claude-custom',
      baseUrl: null,
      apiKey: { kind: 'env', name: 'ANTHROPIC_API_KEY' },
      dataDir: 'D:\\yantra-data',
    });
  });

  it('skips credential prompts for provider none', async () => {
    const password = vi.fn(async () => 'unused');
    const result = await runInitWizard({
      select: async () => 'none',
      text: async () => '',
      password,
    });
    expect(result.provider).toBe('none');
    expect(result.apiKey).toBeNull();
    expect(password).not.toHaveBeenCalled();
  });
});
