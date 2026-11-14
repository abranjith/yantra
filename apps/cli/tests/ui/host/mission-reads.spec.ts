// @no-llm
/**
 * `read.effective_options` (FEAT-067 TASK-009): effective option values and
 * their sources, through FEAT-072's settings resolver.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetPathCache } from '@yantra/core';
import { EffectiveOptions, type EffectiveOptionView } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { effectiveSettingsResolver } from '../../../src/ui/host/drift-review.js';
import { effectiveOptions, registerMissionReads } from '../../../src/ui/host/mission-reads.js';
import {
  RpcError,
  RpcMethodRegistry,
  type RpcCallContext,
} from '../../../src/ui/host/rpc-server.js';

// The real resolver loads the whole command surface on first use.
vi.setConfig({ testTimeout: 60_000 });

const CANARY = 'canary-7f3a9c-secret-value';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YANTRA_HOME;
  home = mkdtempSync(join(tmpdir(), 'yantra-effective-'));
  process.env.YANTRA_HOME = home;
  resetPathCache();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YANTRA_HOME;
  else process.env.YANTRA_HOME = previousHome;
  resetPathCache();
  rmSync(home, { recursive: true, force: true });
});

async function read(
  path: string[],
  argv: string[],
  env: Record<string, string> = {},
): Promise<EffectiveOptions> {
  return effectiveOptions(
    { path, argv, cwd: home },
    effectiveSettingsResolver({ YANTRA_HOME: home, ...env }),
  );
}

function option(result: EffectiveOptions, flag: string): EffectiveOptionView | undefined {
  return result.options.find((item) => item.flag === flag);
}

describe('@no-llm read.effective_options', () => {
  it('resolves flag over environment over preference over default, naming each source', async () => {
    writeFileSync(join(home, 'profile.yaml'), 'agent:\n  model: model-from-profile\n');

    const fromFlag = await read(['research'], ['q', '--model', 'model-from-flag'], {
      YANTRA_AGENT_MODEL: 'model-from-env',
    });
    const fromEnv = await read(['research'], ['q'], { YANTRA_AGENT_MODEL: 'model-from-env' });
    const fromPreference = await read(['research'], ['q']);
    rmSync(join(home, 'profile.yaml'));
    resetPathCache();
    const fromDefault = await read(['research'], ['q']);

    expect(option(fromFlag, '--model')).toEqual({
      option: 'model',
      flag: '--model',
      value: 'model-from-flag',
      source: { kind: 'flag' },
    });
    expect(option(fromEnv, '--model')?.source).toEqual({ kind: 'env', name: 'YANTRA_AGENT_MODEL' });
    expect(option(fromPreference, '--model')).toMatchObject({
      value: 'model-from-profile',
      source: { kind: 'preference', key: 'agent.model' },
    });
    // Whatever the resolver records as the default is what the receipt records too.
    expect(option(fromDefault, '--model')?.source).toEqual({ kind: 'default' });
  });

  it('names an environment source by its variable only, and never returns other variables', async () => {
    const result = await read(['research'], ['q'], {
      YANTRA_AGENT_MAX_TOKENS: '5000',
      ANTHROPIC_API_KEY: CANARY,
      SOME_UNRELATED_VALUE: CANARY,
    });

    expect(option(result, '--max-tokens')?.source).toEqual({
      kind: 'env',
      name: 'YANTRA_AGENT_MAX_TOKENS',
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('shows the secret reference name for --auth-secret, never what it resolves to', async () => {
    const result = await read(['do'], ['fill the form', '--auth-secret', 'anthropic.work'], {
      ANTHROPIC_API_KEY: CANARY,
    });

    expect(option(result, '--auth-secret')).toMatchObject({
      value: 'anthropic.work',
      source: { kind: 'flag' },
    });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('leaves out options that do not apply in the resolved mode', async () => {
    const deterministic = await read(['research'], ['q', '--no-llm']);
    const viaEnvironment = await read(['research'], ['q'], { LLM_PROVIDER: 'none' });
    const agentic = await read(['research'], ['q']);

    expect(deterministic.mode).toBe('deterministic');
    expect(option(deterministic, '--model')).toBeUndefined();
    expect(option(deterministic, '--no-browse')).toBeUndefined();
    expect(option(deterministic, '--pipeline-timeout')).toBeDefined();
    expect(viaEnvironment.mode).toBe('deterministic');
    expect(option(viaEnvironment, '--no-llm')?.source).toEqual({
      kind: 'env',
      name: 'LLM_PROVIDER',
    });
    expect(agentic.mode).toBe('llm');
    expect(option(agentic, '--model')).toBeDefined();
    expect(option(agentic, '--pipeline-timeout')).toBeUndefined();
  });

  it('leaves out known dead controls', async () => {
    writeFileSync(join(home, 'w.yaml'), 'name: w\n');

    const result = await read(['run'], ['nightly']);
    const flags = result.options.map((item) => item.flag);

    for (const dead of ['--template', '--no-screenshots', '--max-duration', '--max-tokens']) {
      expect(flags).not.toContain(dead);
    }
    expect(flags).toContain('--params');
  });

  it('keeps registry help order and matches the protocol schema', async () => {
    const result = await read(['ask'], ['q', '--no-llm']);

    expect(EffectiveOptions.safeParse(result).success).toBe(true);
    const flags = result.options.map((item) => item.flag);
    expect(flags.indexOf('--no-llm')).toBeLessThan(flags.indexOf('--browser'));
  });

  it('refuses an invocation that does not parse, in the parser’s words', async () => {
    const refused = await read(['research'], []).catch((caught: unknown) => caught);

    expect(refused).toBeInstanceOf(RpcError);
    expect((refused as RpcError).data).toMatchObject({ code: 'invalid_params' });
    expect((refused as RpcError).message).toMatch(/missing required argument 'topic'/u);
  });

  it('serves the read over RPC and turns a resolver crash into a safe error', async () => {
    const methods = new RpcMethodRegistry();
    const warn = vi.fn();
    registerMissionReads(methods, {
      resolve: () => Promise.reject(new Error(`exploded with ${CANARY}`)),
      logger: { info: vi.fn(), warn, error: vi.fn() } as never,
    });
    const method = methods.get('read.effective_options')!;

    const refused = await Promise.resolve(
      method.handler(
        method.params.parse({ path: ['ask'], argv: ['q'], cwd: home }),
        {} as RpcCallContext,
      ),
    ).catch((caught: unknown) => caught);

    expect((refused as RpcError).message).toBe('The options could not be resolved.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('"q"');
  });

  it('refuses a relative working directory at the schema', () => {
    const methods = new RpcMethodRegistry();
    registerMissionReads(methods, { resolve: () => Promise.resolve([]) });

    expect(
      methods
        .get('read.effective_options')!
        .params.safeParse({ path: ['ask'], argv: ['q'], cwd: 'rel' }).success,
    ).toBe(false);
  });

  it('serves the host defaults a new run composes from', async () => {
    const methods = new RpcMethodRegistry();
    registerMissionReads(methods, {
      resolve: () => Promise.resolve([]),
      home: () => home,
      platform: 'win32',
    });
    const method = methods.get('read.mission_context')!;

    const context = await Promise.resolve(
      method.handler(method.params.parse({}), {} as RpcCallContext),
    );

    expect(context).toEqual({ home, platform: 'win32' });
    expect(method.result.safeParse({ home: 'relative', platform: 'linux' }).success).toBe(false);
  });
});
