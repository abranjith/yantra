/**
 * The registry's declared precedence chains agree with the resolvers the
 * commands actually call: `resolveAgentInvocation` (agent groups and
 * `--no-llm`), `resolveAskDefaults`, `resolveResearchBrowse` and
 * `resolveAmbientContext` (the screenshot grant).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EffectivePreference, EffectivePreferences } from '@yantra/core';
import {
  COMMAND_REGISTRY,
  expandOptions,
  type ExpandedOption,
  type PrecedenceStep,
} from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  parseDuration,
  resolveAgentInvocation,
  type AgentOptions,
} from '../../src/agent-options.js';
import { resolveAskDefaults } from '../../src/commands/ask.js';
import { resolveAmbientContext } from '../../src/preferences.js';
import { resolveResearchBrowse } from '../../src/research-browse.js';

interface Inputs {
  readonly flag?: unknown;
  readonly env?: Readonly<Record<string, string>>;
  readonly prefs?: Readonly<Record<string, unknown>>;
}

/** Resolves one option's effective value through the resolver its command calls. */
interface Adapter {
  readonly resolve: (inputs: Inputs) => Promise<unknown>;
  /** A flag value that differs from the env and preference samples. */
  readonly flag: unknown;
  /** Samples for the env and preference steps, each different from the default. */
  readonly envSample?: string;
  readonly prefSample?: unknown;
  /** Maps a declared default value into the resolver's units. */
  readonly normalize?: (value: unknown) => unknown;
  /**
   * Layers for the flag-override check, when the samples above coincide with
   * the flag (a downward-only negation such as `--no-browse`).
   */
  readonly overrideInputs?: Inputs;
}

function prefsOf(values: Readonly<Record<string, unknown>> = {}): EffectivePreferences {
  return new Map<string, EffectivePreference>(
    Object.entries(values).map(([key, value]) => [
      key,
      { key, value, source: 'user', approved: true, provenance: 'profile.yaml' },
    ]),
  );
}

const available = () => Promise.resolve({ available: true, authSource: 'test' });

async function agent(attribute: keyof AgentOptions, inputs: Inputs) {
  const options = (inputs.flag === undefined ? {} : { [attribute]: inputs.flag }) as AgentOptions;
  return resolveAgentInvocation('do', options, { ...inputs.env }, prefsOf(inputs.prefs), {
    probeCredential: available,
    personalPiAuthPath: '',
  });
}

async function llmAgent(attribute: keyof AgentOptions, inputs: Inputs) {
  const resolved = await agent(attribute, inputs);
  if (resolved.mode !== 'llm') throw new Error(`expected llm mode, got ${resolved.mode}`);
  return resolved;
}

const ms = (value: unknown): unknown => parseDuration(String(value), 'test');

const ADAPTERS: Readonly<Record<string, Adapter>> = {
  '--provider': {
    resolve: async (i) => (await llmAgent('provider', i)).model.provider,
    flag: 'flag-provider',
    envSample: 'env-provider',
    prefSample: 'pref-provider',
  },
  '--model': {
    resolve: async (i) => (await llmAgent('model', i)).model.id,
    flag: 'flag-model',
    envSample: 'env-model',
    prefSample: 'pref-model',
  },
  '--thinking': {
    resolve: async (i) => (await llmAgent('thinking', i)).model.thinking ?? null,
    flag: 'high',
    envSample: 'low',
    prefSample: 'medium',
  },
  '--auth-secret': {
    resolve: async (i) => {
      const { auth } = await llmAgent('authSecret', i);
      return auth.mode === 'runtime-key' ? auth.secretRef : null;
    },
    flag: 'secret:flag',
    envSample: 'secret:env',
  },
  '--max-duration': {
    resolve: async (i) => (await llmAgent('maxDuration', i)).budgets.wallClockMs,
    flag: '7m',
    envSample: '9m',
    prefSample: '11m',
    normalize: ms,
  },
  '--max-tokens': {
    resolve: async (i) => (await llmAgent('maxTokens', i)).budgets.maxProviderTokens,
    flag: '1000',
    envSample: '2000',
    prefSample: 3000,
  },
  '--tool-timeout': {
    resolve: async (i) => (await llmAgent('toolTimeout', i)).budgets.perToolTimeoutMs,
    flag: '20s',
    envSample: '30s',
    prefSample: '40s',
    normalize: ms,
  },
  '--tool-retries': {
    resolve: async (i) => (await llmAgent('toolRetries', i)).budgets.toolRetries,
    flag: '0',
    envSample: '5',
    prefSample: 7,
  },
  '--confirm-timeout': {
    resolve: async (i) => (await llmAgent('confirmTimeout', i)).budgets.confirmationWaitMs,
    flag: '20s',
    envSample: '30s',
    prefSample: '40s',
    normalize: ms,
  },
  '--turn-timeout': {
    resolve: async (i) => (await llmAgent('turnTimeout', i)).budgets.turnTimeoutMs,
    flag: '20s',
    envSample: '30s',
    prefSample: '40s',
    normalize: ms,
  },
  '--no-llm': {
    resolve: async (i) => {
      const resolved = await agent('llm', i);
      return resolved.mode === 'no-llm' && resolved.reason !== 'unavailable'
        ? `no-llm:${resolved.reason}`
        : 'llm';
    },
    flag: false,
    envSample: 'none',
  },
  '--no-screenshots': {
    // The run's capture permission: the flag only suppresses; the stored grant decides.
    resolve: (i) =>
      Promise.resolve(
        i.flag === false ? false : resolveAmbientContext(prefsOf(i.prefs)).grants.screenshots,
      ),
    flag: false,
    prefSample: true,
  },
  'ask --detail': {
    resolve: (i) =>
      Promise.resolve(
        resolveAskDefaults(
          i.flag === undefined ? {} : { detail: i.flag as never },
          prefsOf(i.prefs),
        ).detail,
      ),
    flag: 'full',
    prefSample: 'overview',
  },
  'ask --length': {
    resolve: (i) =>
      Promise.resolve(
        resolveAskDefaults(
          i.flag === undefined ? {} : { length: i.flag as never },
          prefsOf(i.prefs),
        ).length,
      ),
    flag: 'long',
    prefSample: 'short',
  },
  'ask --search-provider': {
    resolve: (i) =>
      Promise.resolve(
        resolveAskDefaults(
          i.flag === undefined ? {} : { searchProvider: i.flag as never },
          prefsOf(i.prefs),
        ).provider ?? 'auto',
      ),
    flag: 'brave',
    prefSample: 'tavily',
  },
  'research --no-browse': {
    resolve: (i) =>
      Promise.resolve(
        resolveResearchBrowse(
          i.flag === undefined ? {} : { browse: i.flag as boolean },
          prefsOf(i.prefs),
        ).enabled,
      ),
    flag: false,
    prefSample: false,
    overrideInputs: { prefs: { 'agent.research_browse': true } },
  },
};

interface Subject {
  readonly key: string;
  readonly option: ExpandedOption;
  readonly steps: readonly PrecedenceStep[];
}

/** Every option (group options once) whose chain names an env var or a preference. */
function subjects(): readonly Subject[] {
  const seen = new Map<string, Subject>();
  for (const entry of COMMAND_REGISTRY.commands) {
    if (entry.kind !== 'leaf') continue;
    for (const option of expandOptions(entry, COMMAND_REGISTRY.option_groups)) {
      const steps = option.precedence ?? [];
      if (!steps.some((step) => step.source === 'env' || step.source === 'preference')) continue;
      const key = option.group === undefined ? `${entry.id} ${option.long}` : option.long;
      seen.set(key, { key, option, steps });
    }
  }
  return [...seen.values()];
}

const SUBJECTS = subjects();

function envStep(steps: readonly PrecedenceStep[]) {
  return steps.find(
    (step): step is Extract<PrecedenceStep, { source: 'env' }> => step.source === 'env',
  );
}
function prefStep(steps: readonly PrecedenceStep[]) {
  return steps.find(
    (step): step is Extract<PrecedenceStep, { source: 'preference' }> =>
      step.source === 'preference',
  );
}
function defaultStep(steps: readonly PrecedenceStep[]) {
  return steps.find(
    (step): step is Extract<PrecedenceStep, { source: 'default' }> => step.source === 'default',
  );
}

describe('@no-llm declared precedence chains agree with the resolvers', () => {
  it('has a resolver adapter for every option with an env or preference step', () => {
    expect(SUBJECTS.map((subject) => subject.key).filter((key) => !(key in ADAPTERS))).toEqual([]);
    expect(Object.keys(ADAPTERS).filter((key) => !SUBJECTS.some((s) => s.key === key))).toEqual([]);
  });

  it.each(SUBJECTS.map((subject) => [subject.key, subject] as const))(
    '%s resolves flag > env > preference > default',
    async (_key, subject) => {
      const adapter = ADAPTERS[subject.key]!;
      const env = envStep(subject.steps);
      const pref = prefStep(subject.steps);
      const fallback = defaultStep(subject.steps);
      const envInputs =
        env === undefined ? {} : { [env.name]: env.equals ?? adapter.envSample ?? '' };
      const prefInputs = pref === undefined ? {} : { [pref.key]: adapter.prefSample };

      const baseline = await adapter.resolve({});
      if (fallback !== undefined) {
        expect(baseline).toEqual((adapter.normalize ?? ((v: unknown) => v))(fallback.value));
      }
      if (env !== undefined) {
        expect(await adapter.resolve({ env: envInputs })).not.toEqual(baseline);
      }
      if (pref !== undefined) {
        expect(await adapter.resolve({ prefs: prefInputs })).not.toEqual(baseline);
      }
      if (env !== undefined && pref !== undefined) {
        // The environment outranks the preference.
        expect(await adapter.resolve({ env: envInputs, prefs: prefInputs })).toEqual(
          await adapter.resolve({ env: envInputs }),
        );
      }
      // The flag overrides every other layer: the result is the flag's alone,
      // and it differs from what the other layers would have produced.
      const layers = adapter.overrideInputs ?? { env: envInputs, prefs: prefInputs };
      const withFlag = await adapter.resolve({ ...layers, flag: adapter.flag });
      expect(withFlag).toEqual(await adapter.resolve({ flag: adapter.flag }));
      expect(withFlag).not.toEqual(await adapter.resolve(layers));
    },
  );

  it('declares exactly the environment variables the agent resolver reads', () => {
    const source = [
      readFileSync(resolve(import.meta.dirname, '../../src/agent-options.ts'), 'utf8'),
      readFileSync(resolve(import.meta.dirname, '../../src/global-flags.ts'), 'utf8'),
    ].join('\n');
    const read = new Set(
      [...source.matchAll(/env\.((?:YANTRA_AGENT_|LLM_PROVIDER)[A-Z_]*)/g)].map((m) => m[1]!),
    );
    const declared = new Set(
      COMMAND_REGISTRY.option_groups
        .flatMap((group) => group.options)
        .flatMap((option) => option.precedence ?? [])
        .flatMap((step) => (step.source === 'env' ? [step.name] : [])),
    );
    expect([...declared].sort()).toEqual([...read].sort());
  });
});
