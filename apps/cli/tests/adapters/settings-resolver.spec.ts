import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetPathCache, profilePath } from '@yantra/core';
import { COMMAND_REGISTRY, type LeafEntry } from '@yantra/protocol';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsResolver } from '../../src/context/settings-resolver.js';

let home: string;
const research = COMMAND_REGISTRY.commands.find((e) => e.id === 'research') as LeafEntry;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-settings-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
function resolver(env: NodeJS.ProcessEnv = {}, preferences = new Map()) {
  const value = new SettingsResolver(env, () => Promise.resolve(preferences), {
    cwd: home,
    surface: 'terminal',
    invocationId: null,
  });
  const command = new Command();
  value.bind(research, command);
  return { value, command };
}
describe('@no-llm settings provenance', () => {
  it('uses flag, environment, authored preference and pinned default in order', async () => {
    await writeFile(profilePath(), 'agent:\n  model: preferred\n');
    const prefs = new Map([
      [
        'agent.model',
        {
          key: 'agent.model',
          value: 'preferred',
          source: 'user',
          approved: true,
          provenance: 'profile.yaml',
        },
      ],
    ]);
    const h = resolver({ YANTRA_AGENT_MODEL: 'environment' }, prefs);
    h.command.setOptionValueWithSource('model', 'flagged', 'cli');
    expect(await h.value.option('model')).toMatchObject({
      value: 'flagged',
      source: { kind: 'flag' },
    });
    const env = resolver({ YANTRA_AGENT_MODEL: 'environment' }, prefs);
    expect(await env.value.option('model')).toMatchObject({
      value: 'environment',
      source: { kind: 'env', name: 'YANTRA_AGENT_MODEL' },
    });
    expect(await resolver({}, prefs).value.option('model')).toMatchObject({
      value: 'preferred',
      source: { kind: 'preference', key: 'agent.model' },
    });
    expect(await resolver().value.option('model')).toMatchObject({
      value: 'claude-haiku-4-5',
      source: { kind: 'default' },
    });
  });
  it('snapshots environment, memoizes preferences, and excludes unrelated environment from receipts', async () => {
    const env = {
      YANTRA_AGENT_MODEL: 'fixture',
      UNRELATED_TOKEN: 'CANARY_UNRELATED',
      ANTHROPIC_API_KEY: 'CANARY_KEY',
    };
    const h = resolver(env);
    env.YANTRA_AGENT_MODEL = 'changed';
    expect((await h.value.option('model'))?.value).toBe('fixture');
    expect(h.value.preferences()).toBe(h.value.preferences());
    h.value.record('unsafe', 'CANARY_UNRELATED', { kind: 'env', name: 'UNRELATED_TOKEN' });
    const receipt = await h.value.draftReceipt(['research']);
    const bytes = JSON.stringify(receipt);
    expect(bytes).not.toContain('CANARY');
    expect(bytes).not.toContain('UNRELATED_TOKEN');
    expect(bytes).not.toContain('ANTHROPIC_API_KEY');
    expect(receipt.settings.map((s) => s.key)).toContain('depth');
  });
});
