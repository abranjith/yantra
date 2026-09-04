import type { EffectivePreference, EffectivePreferences } from '@yantra/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  addAgentOptions,
  parseDuration,
  resolveAgentInvocation,
} from '../../src/agent-options.js';
import { registerAskCommand } from '../../src/commands/ask.js';
import { registerDoCommand } from '../../src/commands/do.js';
import { registerResearchCommand } from '../../src/commands/research.js';
import { makeResumeCommand } from '../../src/commands/resume.js';
import { makeRunCommand } from '../../src/commands/run.js';

const available = {
  probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
};

function prefs(values: Readonly<Record<string, unknown>>): EffectivePreferences {
  const result = new Map<string, EffectivePreference>();
  for (const [key, value] of Object.entries(values)) {
    result.set(key, {
      key,
      value,
      source: 'user',
      approved: true,
      provenance: 'profile.yaml',
    });
  }
  return result;
}

describe('@no-llm shared agent options', () => {
  it.each([
    ['5', 5],
    ['5ms', 5],
    ['5s', 5_000],
    ['5m', 300_000],
    ['5h', 18_000_000],
  ])('parses duration %s', (raw, expected) => {
    expect(parseDuration(raw, '--duration')).toBe(expected);
  });

  it.each(['', 'abc', '-5m', '5x', '1.5m', '0', '0s'])(
    'rejects invalid duration %j with a typed validation error',
    (raw) => {
      expect(() => parseDuration(raw, '--duration')).toThrowError(
        expect.objectContaining({ code: 'yantra.agent.invalid-duration', exitCode: 1 }),
      );
    },
  );

  it('registers the complete surface without Commander defaults', () => {
    const command = addAgentOptions(new Command('probe'));
    expect(command.options.map((option) => option.long)).toEqual([
      '--provider',
      '--model',
      '--thinking',
      '--auth-secret',
      '--max-duration',
      '--max-tokens',
      '--tool-timeout',
      '--tool-retries',
      '--confirm-timeout',
      '--no-llm',
      '--no-screenshots',
    ]);
    expect(command.options.every((option) => option.defaultValue === undefined)).toBe(true);
  });

  it.each(['ask', 'research', 'do', 'run', 'resume'])(
    'registers the identical complete surface on %s',
    (name) => {
      const parent = new Command();
      registerAskCommand(parent);
      registerResearchCommand(parent);
      registerDoCommand(parent);
      parent.addCommand(makeRunCommand());
      parent.addCommand(makeResumeCommand());
      const expected = [
        '--provider',
        '--model',
        '--thinking',
        '--auth-secret',
        '--max-duration',
        '--max-tokens',
        '--tool-timeout',
        '--tool-retries',
        '--confirm-timeout',
        '--no-llm',
        '--no-screenshots',
      ];

      const command = parent.commands.find((candidate) => candidate.name() === name);
      const shared = command?.options
        .map((option) => option.long)
        .filter((flag): flag is string => expected.includes(flag));
      expect(shared).toEqual(expected);
      expect(
        command?.options
          .filter((option) => expected.includes(option.long))
          .every((option) => option.defaultValue === undefined),
      ).toBe(true);
    },
  );

  it('applies flag > environment > preference > pinned precedence to every setting', async () => {
    const invocation = await resolveAgentInvocation(
      'ask',
      {
        provider: 'flag-provider',
        model: 'flag-model',
        thinking: 'high',
        maxDuration: '20m',
        maxTokens: '400',
        toolTimeout: '4m',
        toolRetries: '5',
        confirmTimeout: '6m',
      },
      {
        YANTRA_AGENT_PROVIDER: 'env-provider',
        YANTRA_AGENT_MODEL: 'env-model',
        YANTRA_AGENT_THINKING: 'medium',
        YANTRA_AGENT_MAX_DURATION: '19m',
        YANTRA_AGENT_MAX_TOKENS: '300',
        YANTRA_AGENT_TOOL_TIMEOUT: '3m',
        YANTRA_AGENT_TOOL_RETRIES: '4',
        YANTRA_AGENT_CONFIRM_TIMEOUT: '5m',
      },
      prefs({
        'agent.provider': 'pref-provider',
        'agent.model': 'pref-model',
        'agent.thinking': 'low',
        'agent.max_duration': '18m',
        'agent.max_tokens': 200,
        'agent.tool_timeout': '2m',
        'agent.tool_retries': 3,
        'agent.confirm_timeout': '4m',
      }),
      available,
    );

    expect(invocation).toMatchObject({
      mode: 'llm',
      model: { provider: 'flag-provider', id: 'flag-model', thinking: 'high' },
      budgets: {
        wallClockMs: 1_200_000,
        maxProviderTokens: 400,
        perToolTimeoutMs: 240_000,
        toolRetries: 5,
        confirmationWaitMs: 360_000,
      },
    });
  });

  it('lets environment beat preferences and preferences beat pinned defaults', async () => {
    const effective = prefs({
      'agent.provider': 'pref-provider',
      'agent.model': 'pref-model',
      'agent.max_duration': '17m',
    });
    const envResult = await resolveAgentInvocation(
      'ask',
      {},
      { YANTRA_AGENT_PROVIDER: 'env-provider', YANTRA_AGENT_MAX_DURATION: '18m' },
      effective,
      available,
    );
    const prefResult = await resolveAgentInvocation('ask', {}, {}, effective, available);
    const pinnedResult = await resolveAgentInvocation('ask', {}, {}, new Map(), available);

    expect(envResult).toMatchObject({
      mode: 'llm',
      model: { provider: 'env-provider', id: 'pref-model' },
      budgets: { wallClockMs: 1_080_000 },
    });
    expect(prefResult).toMatchObject({
      mode: 'llm',
      model: { provider: 'pref-provider', id: 'pref-model' },
      budgets: { wallClockMs: 1_020_000 },
    });
    expect(pinnedResult).toMatchObject({
      mode: 'llm',
      model: { provider: DEFAULT_AGENT_PROVIDER, id: DEFAULT_AGENT_MODEL },
      budgets: {
        wallClockMs: 900_000,
        maxProviderTokens: 2_000_000,
        perToolTimeoutMs: 180_000,
        toolRetries: 3,
        confirmationWaitMs: 180_000,
      },
    });
  });

  it.each(['0', '-1', 'abc'])('rejects invalid --max-tokens %j', async (maxTokens) => {
    await expect(
      resolveAgentInvocation('do', { maxTokens }, {}, new Map(), available),
    ).rejects.toMatchObject({ code: 'yantra.agent.invalid-budget', exitCode: 1 });
  });

  it.each([
    [{ provider: ' ' }, 'yantra.ask.invalid-model'],
    [{ model: '' }, 'yantra.ask.invalid-model'],
    [{ authSecret: '  ' }, 'yantra.ask.invalid-auth-secret'],
  ] as const)('rejects blank session option %#', async (options, code) => {
    await expect(
      resolveAgentInvocation('ask', options, {}, new Map(), available),
    ).rejects.toMatchObject({
      code,
      exitCode: 1,
    });
  });

  it('short-circuits --no-llm before validation or credential probing', async () => {
    const probeCredential = vi.fn(() =>
      Promise.resolve({ available: true, authSource: 'managed' }),
    );
    const result = await resolveAgentInvocation(
      'ask',
      { llm: false, provider: '', maxTokens: 'nope' },
      {},
      new Map(),
      { probeCredential },
    );

    expect(result).toEqual({ mode: 'no-llm', reason: 'flag' });
    expect(probeCredential).not.toHaveBeenCalled();
  });

  it.each(['do', 'ask', 'research'])(
    'exposes only the downward screenshot override on %s',
    (name) => {
      const parent = new Command();
      registerAskCommand(parent);
      registerResearchCommand(parent);
      registerDoCommand(parent);
      const command = parent.commands.find((candidate) => candidate.name() === name);
      const option = command?.options.find((candidate) => candidate.long === '--no-screenshots');
      expect(option).toMatchObject({
        long: '--no-screenshots',
        description: 'suppress vision assist for this run',
      });
      expect(command?.options.some((candidate) => candidate.long === '--screenshots')).toBe(false);
    },
  );

  it('stores --no-screenshots using Commander negation semantics and leaves absence unset', () => {
    const absent = addAgentOptions(new Command('probe').exitOverride());
    absent.parse([], { from: 'user' });
    expect(absent.opts()).toMatchObject({ screenshots: true });

    const suppressed = addAgentOptions(new Command('probe').exitOverride());
    suppressed.parse(['--no-screenshots'], { from: 'user' });
    expect(suppressed.opts()).toMatchObject({ screenshots: false });

    const positive = addAgentOptions(new Command('probe').exitOverride());
    expect(() => positive.parse(['--screenshots'], { from: 'user' })).toThrowError(
      expect.objectContaining({ code: 'commander.unknownOption' }),
    );
  });

  it('short-circuits LLM_PROVIDER=none with the env reason', async () => {
    await expect(
      resolveAgentInvocation('ask', {}, { LLM_PROVIDER: 'none' }, new Map(), available),
    ).resolves.toEqual({ mode: 'no-llm', reason: 'env' });
  });

  it('degrades to unavailable when the offline credential probe finds no source', async () => {
    const result = await resolveAgentInvocation('ask', {}, {}, new Map(), {
      probeCredential: () => Promise.resolve({ available: false, authSource: 'unavailable' }),
    });

    expect(result).toMatchObject({
      mode: 'no-llm',
      reason: 'unavailable',
      model: { provider: DEFAULT_AGENT_PROVIDER, id: DEFAULT_AGENT_MODEL },
    });
  });

  it('treats a throwing credential probe as unavailable', async () => {
    const result = await resolveAgentInvocation('ask', {}, {}, new Map(), {
      probeCredential: () => Promise.reject(new Error('keychain unavailable')),
    });

    expect(result).toMatchObject({ mode: 'no-llm', reason: 'unavailable' });
  });
});
