import type { EffectivePreference, EffectivePreferences } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  runAgentDiagnostics,
  type AgentDiagnosticOptions,
} from '../../src/runtime/diagnostics.js';

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

const available = {
  probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' as const }),
};

describe('agent runtime diagnostics', () => {
  it('reports flag > environment > profile > default model precedence and sources', async () => {
    const profile = prefs({
      'agent.provider': 'profile-provider',
      'agent.model': 'profile-model',
    });

    const fromFlag = await runAgentDiagnostics(
      { YANTRA_AGENT_PROVIDER: 'env-provider', YANTRA_AGENT_MODEL: 'env-model' },
      profile,
      { provider: 'flag-provider', model: 'flag-model' },
      available,
    );
    const fromEnv = await runAgentDiagnostics(
      { YANTRA_AGENT_PROVIDER: 'env-provider', YANTRA_AGENT_MODEL: 'env-model' },
      profile,
      {},
      available,
    );
    const fromProfile = await runAgentDiagnostics({}, profile, {}, available);
    const fromDefault = await runAgentDiagnostics({}, new Map(), {}, available);

    expect(fromFlag[0]?.details).toMatchObject({
      provider: { value: 'flag-provider', source: 'flag' },
      model: { value: 'flag-model', source: 'flag' },
    });
    expect(fromEnv[0]?.details).toMatchObject({
      provider: { value: 'env-provider', source: 'env' },
      model: { value: 'env-model', source: 'env' },
    });
    expect(fromProfile[0]?.details).toMatchObject({
      provider: { value: 'profile-provider', source: 'profile' },
      model: { value: 'profile-model', source: 'profile' },
    });
    expect(fromDefault[0]?.details).toMatchObject({
      provider: { value: DEFAULT_AGENT_PROVIDER, source: 'default' },
      model: { value: DEFAULT_AGENT_MODEL, source: 'default' },
    });
  });

  it('reports a missing credential as warn and never error', async () => {
    const checks = await runAgentDiagnostics(
      {},
      new Map(),
      {},
      {
        probeCredential: () =>
          Promise.resolve({ available: false, authSource: 'unavailable' as const }),
      },
    );
    const credential = checks.find((check) => check.id === 'agent.credentials');

    expect(credential).toMatchObject({
      status: 'warn',
      details: { authSource: 'unavailable' },
    });
    expect(credential?.fixHint).toContain('--auth-secret');
  });

  it('preserves user-entered budget units and reports each source', async () => {
    const checks = await runAgentDiagnostics(
      {
        YANTRA_AGENT_MAX_DURATION: '2h',
        YANTRA_AGENT_MAX_TOKENS: '987654',
        YANTRA_AGENT_TOOL_TIMEOUT: '90s',
      },
      prefs({
        'agent.tool_retries': 7,
        'agent.confirm_timeout': '4m',
      }),
      {},
      available,
    );
    const budgets = checks.find((check) => check.id === 'agent.budgets');

    expect(budgets?.details).toMatchObject({
      duration: { value: '2h', source: 'env' },
      tokens: { value: '987654', source: 'env' },
      toolTimeout: { value: '90s', source: 'env' },
      retries: { value: 7, source: 'profile' },
      confirmTimeout: { value: '4m', source: 'profile' },
    });
    expect(budgets?.status).toBe('ok');
    expect(budgets?.message).toContain('duration=2h');
    expect(budgets?.message).toContain('tool-timeout=90s');
  });

  it('resolves budgets from stored state only, ignoring any per-run flag value', async () => {
    // Budgets are configuration, not a doctor input: `doctor` reports what the
    // next agentic run would use, and per-run flags are not registered on it.
    const checks = await runAgentDiagnostics(
      {},
      prefs({ 'agent.max_duration': '18m' }),
      { maxDuration: '2h' } as AgentDiagnosticOptions,
      available,
    );

    expect(checks.find((check) => check.id === 'agent.budgets')?.details).toMatchObject({
      duration: { value: '18m', source: 'profile' },
    });
  });

  describe('stored budget validation', () => {
    it.each([
      ['YANTRA_AGENT_MAX_DURATION', 'soon', 'max_duration'],
      ['YANTRA_AGENT_MAX_DURATION', '1.5m', 'max_duration'],
      ['YANTRA_AGENT_MAX_DURATION', '0', 'max_duration'],
      ['YANTRA_AGENT_MAX_DURATION', '-5m', 'max_duration'],
      ['YANTRA_AGENT_MAX_DURATION', '5x', 'max_duration'],
      ['YANTRA_AGENT_MAX_TOKENS', 'lots', 'max_tokens'],
      ['YANTRA_AGENT_MAX_TOKENS', '0', 'max_tokens'],
      ['YANTRA_AGENT_MAX_TOKENS', '-1', 'max_tokens'],
      ['YANTRA_AGENT_TOOL_TIMEOUT', 'never', 'tool_timeout'],
      ['YANTRA_AGENT_TOOL_RETRIES', 'many', 'tool_retries'],
      ['YANTRA_AGENT_TOOL_RETRIES', '-1', 'tool_retries'],
      ['YANTRA_AGENT_CONFIRM_TIMEOUT', '', 'confirm_timeout'],
    ])('fails the budget check when %s is %j', async (variable, value, setting) => {
      const checks = await runAgentDiagnostics({ [variable]: value }, new Map(), {}, available);
      const budgets = checks.find((check) => check.id === 'agent.budgets');

      expect(budgets?.status).toBe('error');
      expect(budgets?.message).toContain(setting);
      expect(budgets?.fixHint).toContain(variable);
    });

    it('accepts a blank-unit millisecond budget and a zero retry count', async () => {
      const checks = await runAgentDiagnostics(
        { YANTRA_AGENT_MAX_DURATION: '900000', YANTRA_AGENT_TOOL_RETRIES: '0' },
        new Map(),
        {},
        available,
      );

      expect(checks.find((check) => check.id === 'agent.budgets')?.status).toBe('ok');
    });

    it('names every invalid setting at once rather than only the first', async () => {
      const checks = await runAgentDiagnostics(
        { YANTRA_AGENT_MAX_DURATION: 'soon', YANTRA_AGENT_TOOL_RETRIES: 'many' },
        new Map(),
        {},
        available,
      );
      const budgets = checks.find((check) => check.id === 'agent.budgets');

      expect(budgets?.message).toContain('max_duration');
      expect(budgets?.message).toContain('tool_retries');
      expect(budgets?.details).toMatchObject({
        invalid: [
          expect.objectContaining({ setting: 'max_duration', source: 'env' }),
          expect.objectContaining({ setting: 'tool_retries', source: 'env' }),
        ],
      });
    });

    it('points a bad profile value at `yantra prefs`, not at an environment variable', async () => {
      const checks = await runAgentDiagnostics(
        {},
        prefs({ 'agent.tool_timeout': 'whenever' }),
        {},
        available,
      );
      const budgets = checks.find((check) => check.id === 'agent.budgets');

      expect(budgets?.status).toBe('error');
      expect(budgets?.fixHint).toContain('yantra prefs set agent.tool_timeout');
      expect(budgets?.fixHint).not.toContain('YANTRA_AGENT_TOOL_TIMEOUT');
    });

    it('reports pinned defaults as valid', async () => {
      const checks = await runAgentDiagnostics({}, new Map(), {}, available);

      expect(checks.find((check) => check.id === 'agent.budgets')).toMatchObject({
        status: 'ok',
        fixHint: null,
      });
    });
  });

  describe('deterministic path selection', () => {
    it.each([
      ['flag' as const, '--no-llm'],
      ['env' as const, 'LLM_PROVIDER=none'],
    ])('reports the no-LLM selection made by %s and skips the probe', async (reason, spelling) => {
      let probed = false;
      const checks = await runAgentDiagnostics(
        {},
        new Map(),
        { noLlm: reason },
        {
          probeCredential: () => {
            probed = true;
            return Promise.resolve({ available: true, authSource: 'environment' as const });
          },
        },
      );

      expect(probed).toBe(false);
      expect(checks.map((check) => check.id)).toEqual([
        'agent.model',
        'agent.credentials',
        'agent.budgets',
      ]);
      expect(checks.every((check) => check.status === 'ok')).toBe(true);
      for (const check of checks) {
        expect(check.message).toContain(spelling);
        expect(check.details).toMatchObject({ noLlm: true });
      }
    });

    it('does not report a missing credential as a warning on the deterministic path', async () => {
      const checks = await runAgentDiagnostics(
        {},
        new Map(),
        { noLlm: 'flag' },
        {
          probeCredential: () =>
            Promise.resolve({ available: false, authSource: 'unavailable' as const }),
        },
      );

      expect(checks.find((check) => check.id === 'agent.credentials')?.status).toBe('ok');
    });

    it('never fails the budget check for an invalid stored budget it will not use', async () => {
      const checks = await runAgentDiagnostics(
        { YANTRA_AGENT_MAX_DURATION: 'soon' },
        new Map(),
        { noLlm: 'env' },
        available,
      );

      expect(checks.find((check) => check.id === 'agent.budgets')?.status).toBe('ok');
    });
  });

  it('converts a failing credential probe into an unavailable warning', async () => {
    const checks = await runAgentDiagnostics(
      {},
      new Map(),
      {},
      {
        probeCredential: () => Promise.reject(new Error('keychain locked')),
      },
    );

    expect(checks.find((check) => check.id === 'agent.credentials')).toMatchObject({
      status: 'warn',
      details: { authSource: 'unavailable' },
    });
  });
});
