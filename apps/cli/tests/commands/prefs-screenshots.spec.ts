import { IndexDbError, type PreferenceStore } from '@yantra/core';
import { err, ok } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { emitScreenshotRevocation, persistPreferenceSet } from '../../src/commands/prefs.js';

function setStore(
  implementation: PreferenceStore['set'] = () => Promise.resolve(ok(undefined)),
): Pick<PreferenceStore, 'set'> {
  return { set: vi.fn(implementation) };
}

describe('@no-llm screenshot preference consent', () => {
  it('writes the warning before invoking the store', async () => {
    const output: string[] = [];
    const store = setStore(() => {
      expect(output.join('')).toContain('raw, unmasked pixels');
      return Promise.resolve(ok(undefined));
    });

    await persistPreferenceSet({
      store,
      key: 'context.screenshots',
      value: true,
      json: false,
      provider: 'anthropic',
      write: (text) => output.push(text),
    });

    expect(store.set).toHaveBeenCalledOnce();
  });

  it('retains the warning when persistence rejects', async () => {
    const output: string[] = [];
    const store = setStore(() => Promise.reject(new Error('disk failed')));
    await expect(
      persistPreferenceSet({
        store,
        key: 'context.screenshots',
        value: true,
        json: false,
        provider: 'anthropic',
        write: (text) => output.push(text),
      }),
    ).rejects.toThrow('disk failed');
    expect(output.join('')).toContain('raw, unmasked pixels');
  });

  it('names every exposure, destination, and retention clause', async () => {
    const output: string[] = [];
    await persistPreferenceSet({
      store: setStore(),
      key: 'context.screenshots',
      value: true,
      json: false,
      provider: 'anthropic',
      write: (text) => output.push(text),
    });
    const warning = output.join('');
    for (const clause of [
      'raw, unmasked pixels',
      'sanitizer cannot inspect',
      'logged-in content',
      'names',
      'balances',
      'message bodies',
      'anything visible on screen',
      'configured model provider',
      'retained locally',
      'run directory',
      'raw provider session log',
    ]) {
      expect(warning).toContain(clause);
    }
  });

  it('softens only the Ollama destination clause', async () => {
    const output: string[] = [];
    await persistPreferenceSet({
      store: setStore(),
      key: 'context.screenshots',
      value: true,
      json: false,
      provider: 'ollama',
      write: (text) => output.push(text),
    });
    const warning = output.join('');
    expect(warning).toContain('local model runtime you configured, not a remote provider');
    expect(warning).toContain('raw, unmasked pixels');
    expect(warning).toContain('retained locally');
  });

  it('emits structured JSON warning before the caller emits the set payload', async () => {
    const output: string[] = [];
    await persistPreferenceSet({
      store: setStore(),
      key: 'context.screenshots',
      value: true,
      json: true,
      provider: 'anthropic',
      write: (text) => output.push(text),
    });
    output.push(`${JSON.stringify({ status: 'set' })}\n`);
    const rows = output
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ status: 'warning', key: 'context.screenshots' });
    expect(rows[1]).toEqual({ status: 'set' });
  });

  it.each([false, 'forget'])('prints revocation for %s', (operation) => {
    const output: string[] = [];
    const value = operation === 'forget' ? false : operation;
    expect(
      emitScreenshotRevocation('context.screenshots', value, false, (text) => output.push(text)),
    ).toBe(true);
    expect(output.join('')).toContain('screenshot capture is now denied');
    expect(output.join('')).toContain('past run directories are not deleted');
  });

  it('prints no warning for an unrelated key', async () => {
    const output: string[] = [];
    const result = await persistPreferenceSet({
      store: setStore(() => Promise.resolve(err(new IndexDbError('expected', { op: 'test' })))),
      key: 'defaults.detail',
      value: 'full',
      json: false,
      provider: 'anthropic',
      write: (text) => output.push(text),
    });
    expect(result.isOk).toBe(false);
    expect(output).toEqual([]);
  });
});
