// @no-llm
import { describe, expect, it } from 'vitest';

import {
  EffectiveOptions,
  EffectiveOptionsParams,
  MissionContext,
  ProviderReadiness,
  RunRecoveryAssessment,
  WorkflowParams,
} from '../../src/schemas/ui-mission.js';

describe('Mission read schemas (FEAT-067)', () => {
  it('round-trips effective options with every source kind', () => {
    const value = {
      path: ['research'],
      mode: 'llm',
      options: [
        { option: 'model', flag: '--model', value: 'm', source: { kind: 'flag' } },
        {
          option: 'maxTokens',
          flag: '--max-tokens',
          value: 5000,
          source: { kind: 'env', name: 'YANTRA_AGENT_MAX_TOKENS' },
        },
        {
          option: 'detail',
          flag: '--detail',
          value: 'full',
          source: { kind: 'preference', key: 'defaults.detail' },
        },
        {
          option: 'browser',
          flag: '--browser',
          value: 'auto',
          source: { kind: 'config', key: 'browser.source' },
        },
        { option: 'thinking', flag: '--thinking', value: null, source: { kind: 'default' } },
      ],
    };

    expect(EffectiveOptions.parse(value)).toEqual(value);
  });

  it('refuses an environment source that carries more than a variable name', () => {
    expect(
      EffectiveOptions.safeParse({
        path: ['ask'],
        mode: 'llm',
        options: [
          {
            option: 'model',
            flag: '--model',
            value: 'm',
            source: { kind: 'env', name: 'YANTRA_AGENT_MODEL=m' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('needs an absolute working directory and a lower-case command path', () => {
    expect(
      EffectiveOptionsParams.safeParse({ path: ['ask'], argv: [], cwd: '/home/u' }).success,
    ).toBe(true);
    expect(
      EffectiveOptionsParams.safeParse({ path: ['ask'], argv: [], cwd: 'C:\\u' }).success,
    ).toBe(true);
    expect(EffectiveOptionsParams.safeParse({ path: ['ask'], argv: [], cwd: 'u' }).success).toBe(
      false,
    );
    expect(EffectiveOptionsParams.safeParse({ path: ['Ask'], argv: [], cwd: '/u' }).success).toBe(
      false,
    );
    expect(EffectiveOptionsParams.safeParse({ path: [], argv: [], cwd: '/u' }).success).toBe(false);
  });

  it('round-trips provider readiness, ready and not', () => {
    const ready = { ready: true, provider: 'anthropic', model: 'claude-haiku-4-5' };
    const notReady = {
      ready: false,
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      reason: 'No credential is stored for anthropic.',
      fix: { label: 'Store the key', path: ['secret', 'set'], argv: ['anthropic.api_key'] },
    };

    expect(ProviderReadiness.parse(ready)).toEqual(ready);
    expect(ProviderReadiness.parse(notReady)).toEqual(notReady);
    expect(ProviderReadiness.safeParse({ ...ready, extra: 1 }).success).toBe(false);
  });

  it('round-trips workflow params and the mission context', () => {
    const params = {
      name: 'nightly',
      params: [
        { key: 'city', type: 'string', required: true, example: 'Pune' },
        { key: 'limit', type: 'number', required: false, example: null },
      ],
    };

    expect(WorkflowParams.parse(params)).toEqual(params);
    expect(
      WorkflowParams.safeParse({
        ...params,
        params: [{ key: 'x', type: 'list', required: true, example: null }],
      }).success,
    ).toBe(false);
    expect(MissionContext.parse({ home: '/home/u', platform: 'linux' })).toEqual({
      home: '/home/u',
      platform: 'linux',
    });
    expect(MissionContext.safeParse({ home: '~', platform: 'linux' }).success).toBe(false);
  });

  it('round-trips a recovery assessment with and without Resume', () => {
    const resumable = {
      run_id: 'r-1',
      resume: { available: true, requires_consent: true, failure_class: 'scope_violation' },
      run_again: {
        prior: 'receipt',
        path: ['run'],
        argv: ['nightly'],
        pinned_argv: ['nightly', '--debug'],
        cwd: '/home/u',
        effects: 'possible',
        effect_reasons: ['It was allowed to submit a form.'],
        notices: [],
      },
    };
    const notResumable = {
      ...resumable,
      resume: {
        available: false,
        reason: 'Only saved workflow runs can be resumed. Use Run again.',
      },
      run_again: {
        ...resumable.run_again,
        prior: null,
        path: null,
        argv: null,
        pinned_argv: null,
        cwd: null,
      },
    };

    expect(RunRecoveryAssessment.parse(resumable)).toEqual(resumable);
    expect(RunRecoveryAssessment.parse(notResumable)).toEqual(notResumable);
    expect(RunRecoveryAssessment.safeParse({ ...resumable, run_id: '../x' }).success).toBe(false);
  });
});
