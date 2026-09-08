import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { resetPathCache, type KeychainProvider } from '@yantra/core';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';

import { makeSecretCommand, type SecretRuntime } from '../../src/commands/secret.js';

function sink(): { readonly stream: Writable; read(): string } {
  let text = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        text += String(chunk);
        done();
      },
    }),
    read: () => text,
  };
}

function fixture(available = true) {
  const values = new Map<string, string>();
  const keychain: KeychainProvider = {
    get: async (_service, key) => values.get(key) ?? null,
    set: async (_service, key, value) => {
      values.set(key, value);
    },
    delete: async (_service, key) => values.delete(key),
    list: async () => [...values.keys()].map((account) => ({ account })),
    isAvailable: async () => available,
  };
  const stdout = sink();
  const stderr = sink();
  const runtime: SecretRuntime = {
    env: {},
    stdin: Readable.from(['CANARY-value\n']),
    stdout: stdout.stream,
    stderr: stderr.stream,
    isTty: false,
    createKeychain: async () => keychain,
    promptSecret: async () => 'CANARY-value',
  };
  return { values, stdout, stderr, runtime };
}

describe('@no-llm secret command', () => {
  it('rejects values passed in argv', async () => {
    const f = fixture();
    await expect(
      makeSecretCommand(f.runtime).parseAsync(['set', 'tavily.api_key', 'leak'], { from: 'user' }),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(f.stderr.read()).toContain('never accepted in argv');
  });

  it('accepts piped input, trims one newline, and never prints it', async () => {
    const f = fixture();
    await makeSecretCommand(f.runtime).parseAsync(['set', 'tavily.api_key'], { from: 'user' });
    expect(f.values.get('tavily.api_key')).toBe('CANARY-value');
    expect(f.stdout.read() + f.stderr.read()).not.toContain('CANARY-value');
  });

  it('lists sources and removes absent keys successfully', async () => {
    const f = fixture();
    f.values.set('tavily.api_key', 'hidden');
    await makeSecretCommand(f.runtime).parseAsync(['list'], { from: 'user' });
    expect(f.stdout.read()).toContain('tavily.api_key\tkeychain');
    await makeSecretCommand(f.runtime).parseAsync(['rm', 'missing'], { from: 'user' });
    expect(f.stdout.read()).toContain('missing\tabsent');
    expect(f.stdout.read()).not.toContain('hidden');
  });

  it('lists an environment-backed config reference without its value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yantra-secret-list-'));
    const savedHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    const f = fixture();
    f.runtime.env.TAVILY_TEST_KEY = 'CANARY-search-secret';
    try {
      await writeFile(
        join(root, 'config.yaml'),
        'search:\n  tavily:\n    api_key: ${env:TAVILY_TEST_KEY}\n',
      );
      await makeSecretCommand(f.runtime).parseAsync(['list'], { from: 'user' });
      expect(f.stdout.read()).toContain('tavily.api_key\tenv');
      expect(f.stdout.read()).not.toContain('CANARY-search-secret');
    } finally {
      if (savedHome === undefined) delete process.env.YANTRA_HOME;
      else process.env.YANTRA_HOME = savedHome;
      resetPathCache();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable keychains as environment failures with env-ref guidance', async () => {
    const f = fixture(false);
    try {
      await makeSecretCommand(f.runtime).parseAsync(['set', 'tavily.api_key'], { from: 'user' });
    } catch (error) {
      expect((error as CommanderError).exitCode).toBe(3);
    }
    expect(f.stderr.read()).toContain('${env:NAME}');
  });
});
