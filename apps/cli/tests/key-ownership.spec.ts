import { KNOWN_CONFIG_KEYS, KNOWN_PREFERENCE_KEYS } from '@yantra/core';
import { describe, expect, it, vi } from 'vitest';

import { keyOwner, keyOwnershipEntries } from '../src/key-ownership.js';

describe('@no-llm key ownership', () => {
  it('assigns every schema key to exactly one owner', () => {
    const entries = keyOwnershipEntries();
    const keys = entries.map(([key]) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...KNOWN_CONFIG_KEYS, ...KNOWN_PREFERENCE_KEYS].sort());
    for (const key of KNOWN_CONFIG_KEYS) expect(keyOwner(key)).toBe('config');
    for (const key of KNOWN_PREFERENCE_KEYS) expect(keyOwner(key)).toBe('prefs');
  });

  // The browser binding answers "what is installed?", so it belongs to
  // `yantra config` — and `prefs` must redirect by name rather than write the
  // wrong file or fail silently.
  it.each(['browser.source', 'browser.executable_path'])(
    'routes %s to config and redirects prefs by name',
    async (key) => {
      expect(keyOwner(key)).toBe('config');

      const { makePrefsCommand } = await import('../src/commands/prefs.js');
      const stderr: string[] = [];
      const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      }) as never);
      // `prefs` reports the redirect and exits; intercepting the exit is what
      // proves it never reached the preference store.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit:${String(code)}`);
      }) as never);

      try {
        await expect(
          makePrefsCommand().parseAsync(['set', key, 'managed'], { from: 'user' }),
        ).rejects.toThrow('exit:1');
      } finally {
        exitSpy.mockRestore();
        errSpy.mockRestore();
      }

      expect(stderr.join('')).toContain(`yantra config set ${key} managed`);
    },
  );
});
