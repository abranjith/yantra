import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentDiagnostics } from '@yantra/agent';
import { loadConfig, loadProfile, resetPathCache } from '@yantra/core';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeModelCommand } from '../../src/commands/model.js';
import { loadEffectivePreferences } from '../../src/preferences.js';

describe('@no-llm model command', () => {
  let root: string;
  let savedHome: string | undefined;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-model-command-'));
    savedHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = root;
    resetPathCache();
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedHome;
    resetPathCache();
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: readonly string[]): Promise<void> {
    await makeModelCommand()
      .exitOverride()
      .parseAsync([...args], { from: 'user' });
  }

  it('adds, force-replaces, and validates provider-specific model entries', async () => {
    await run(['add', 'claude-test', '--provider', 'anthropic', '--input', 'text,image']);
    await expect(run(['add', 'claude-test', '--provider', 'anthropic'])).rejects.toBeInstanceOf(
      CommanderError,
    );
    expect(stderr.join('')).toContain('--force');
    await run(['add', 'claude-test', '--provider', 'anthropic', '--force']);
    const loaded = await loadConfig();
    expect(loaded.isOk && loaded.value.models).toHaveLength(1);
    await expect(run(['add', 'local', '--provider', 'ollama'])).rejects.toBeInstanceOf(
      CommanderError,
    );
    await expect(
      run(['add', 'unsafe', '--provider', 'anthropic', '--api-key-ref', 'literal-secret']),
    ).rejects.toBeInstanceOf(CommanderError);
    expect(stderr.join('')).toContain('yantra secret set');
  });

  it('writes the default to profile and refuses to remove it without force', async () => {
    await run(['add', 'llama', '--provider', 'ollama', '--base-url', 'http://localhost:11434']);
    await run(['default', 'llama']);
    const profile = await loadProfile();
    expect(profile.isOk && profile.value.agent).toMatchObject({
      provider: 'ollama',
      model: 'llama',
    });
    const diagnostics = await runAgentDiagnostics(
      {},
      await loadEffectivePreferences(),
      {},
      { probeCredential: async () => ({ available: true, authSource: 'environment' }) },
    );
    expect(diagnostics.find((check) => check.id === 'agent.model')?.details).toMatchObject({
      provider: { value: 'ollama', source: 'profile' },
      model: { value: 'llama', source: 'profile' },
    });
    await expect(run(['rm', 'llama'])).rejects.toBeInstanceOf(CommanderError);
    expect(stderr.join('')).toContain('current default');
    await run(['rm', 'llama', '--force']);
    const loaded = await loadConfig();
    expect(loaded.isOk && loaded.value.models).toEqual([]);
  });

  it('lists credential provenance without exposing environment material', async () => {
    const canary = 'CANARY-model-secret';
    process.env.MODEL_TEST_API_KEY = canary;
    try {
      await run([
        'add',
        'secure-model',
        '--provider',
        'anthropic',
        '--api-key-ref',
        '${env:MODEL_TEST_API_KEY}',
      ]);
      stdout = [];
      await run(['list', '--json']);
      const rendered = stdout.join('');
      expect(rendered).toContain('"credential":"env"');
      expect(rendered).not.toContain(canary);
    } finally {
      delete process.env.MODEL_TEST_API_KEY;
    }
  });
});
