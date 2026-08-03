import type { EffectivePreference, EffectivePreferences } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_PROVIDER,
  runAgentDiagnostics,
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
        YANTRA_AGENT_MAX_TOKENS: '987654',
        YANTRA_AGENT_TOOL_TIMEOUT: '90s',
      },
      prefs({
        'agent.tool_retries': 7,
        'agent.confirm_timeout': '4m',
      }),
      { maxDuration: '2h' },
      available,
    );
    const budgets = checks.find((check) => check.id === 'agent.budgets');

    expect(budgets?.details).toMatchObject({
      duration: { value: '2h', source: 'flag' },
      tokens: { value: '987654', source: 'env' },
      toolTimeout: { value: '90s', source: 'env' },
      retries: { value: 7, source: 'profile' },
      confirmTimeout: { value: '4m', source: 'profile' },
    });
    expect(budgets?.message).toContain('duration=2h');
    expect(budgets?.message).toContain('tool-timeout=90s');
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
