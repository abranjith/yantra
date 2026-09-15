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

  describe('browser binding', () => {
    it('defaults to automatic selection with no explicit path', () => {
      expect(configSchema.parse({})).toMatchObject({
        browser: { source: 'auto', executable_path: null },
      });
    });

    it.each(['auto', 'managed', 'system'] as const)('accepts source %s', (source) => {
      expect(configSchema.safeParse({ browser: { source } }).success).toBe(true);
    });

    it('rejects an unknown source', () => {
      expect(configSchema.safeParse({ browser: { source: 'firefox' } }).success).toBe(false);
    });

    it.each([
      ['POSIX', '/opt/google/chrome/chrome'],
      ['Win32', String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`],
    ])('accepts a %s absolute path under source system', (_spelling, executable_path) => {
      const result = configSchema.safeParse({
        browser: { source: 'system', executable_path },
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.browser.executable_path).toBe(executable_path);
    });

    it('rejects a relative executable path', () => {
      const result = configSchema.safeParse({
        browser: { source: 'system', executable_path: 'chrome/chrome' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects an empty executable path', () => {
      const result = configSchema.safeParse({
        browser: { source: 'system', executable_path: '   ' },
      });
      expect(result.success).toBe(false);
    });

    // The cross-field rule is the whole reason the writer commits both fields at
    // once: a stale path under a non-system source is a half-written selection.
    it.each(['auto', 'managed'] as const)(
      'rejects an executable path under source %s and names the repair command',
      (source) => {
        const result = configSchema.safeParse({
          browser: { source, executable_path: '/opt/google/chrome/chrome' },
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          const issue = result.error.issues.find(
            (candidate) => candidate.path.join('.') === 'browser.executable_path',
          );
          expect(issue?.message).toContain('yantra browser use system --path');
        }
      },
    );

    it('rejects an unknown browser key rather than ignoring it', () => {
      const result = configSchema.safeParse({
        browser: { source: 'auto', selected_build: '153.0.8010.36' },
      });
      expect(result.success).toBe(false);
    });
  });
});
