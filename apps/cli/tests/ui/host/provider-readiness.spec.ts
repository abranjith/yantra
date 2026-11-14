// @no-llm
/**
 * `read.provider_readiness` (FEAT-067 TASK-012): whether `do` can run, and
 * the real command that fixes it when it cannot.
 */

import { COMMAND_REGISTRY, ProviderReadiness, findLeaf } from '@yantra/protocol';
import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInvocation } from '../../../src/agent-options.js';
import {
  providerReadiness,
  registerMissionReads,
  type AgentResolver,
} from '../../../src/ui/host/mission-reads.js';
import { RpcMethodRegistry, type RpcCallContext } from '../../../src/ui/host/rpc-server.js';

const CWD = process.platform === 'win32' ? 'C:\\work' : '/work';
const CANARY = 'canary-91be-secret-value';

/** The command's own resolver with an offline credential probe. */
function resolver(available: boolean) {
  const probe = vi.fn(() =>
    Promise.resolve({ available, authSource: available ? 'keychain' : 'none' }),
  );
  const resolve: AgentResolver = (command, options, env) =>
    resolveAgentInvocation(command, options, env, new Map(), { probeCredential: probe });
  return { probe, resolve };
}

function read(argv: string[], resolve: AgentResolver, env: NodeJS.ProcessEnv = {}) {
  return providerReadiness(
    { path: ['do'], argv: ['fill the form', ...argv], cwd: CWD },
    env,
    resolve,
  );
}

describe('@no-llm read.provider_readiness', () => {
  it('is ready when the provider has a credential, through the command’s own chain', async () => {
    const { probe, resolve } = resolver(true);

    const result = await read(['--provider', 'anthropic', '--model', 'claude-haiku-4-5'], resolve);

    expect(result).toEqual({ ready: true, provider: 'anthropic', model: 'claude-haiku-4-5' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]?.[0]).toMatchObject({
      provider: 'anthropic',
      auth: { mode: 'managed' },
    });
  });

  it('is not ready without a credential, naming why and a real command that fixes it', async () => {
    const { resolve } = resolver(false);

    const result = await read([], resolve, { YANTRA_AGENT_PROVIDER: 'openai' });

    expect(result).toMatchObject({
      ready: false,
      provider: 'openai',
      reason: 'No credential for openai is set up on this computer.',
      fix: { path: ['init'], argv: [] },
    });
    expect(findLeaf(result.fix!.path)).toBeDefined();
  });

  it('points a missing runtime key at storing that secret', async () => {
    const { resolve } = resolver(false);

    const result = await read(['--auth-secret', 'anthropic.work'], resolve);

    expect(result).toMatchObject({
      ready: false,
      reason: 'The secret anthropic.work is not stored on this computer.',
      fix: { label: 'Store anthropic.work', path: ['secret', 'set'], argv: ['anthropic.work'] },
    });
    const entry = findLeaf(result.fix!.path)!;
    // The value is a secret input: the fix names the key only, never a value.
    expect(entry.arguments.find((argument) => argument.name === 'value')?.input.kind).toBe(
      'secret-input',
    );
    expect(result.fix!.argv).toHaveLength(1);
  });

  it('says when the model is turned off, with no fix to run', async () => {
    const { probe, resolve } = resolver(true);

    const byFlag = await read(['--no-llm'], resolve);
    const byEnvironment = await read([], resolve, { LLM_PROVIDER: 'none' });

    expect(byFlag).toMatchObject({
      ready: false,
      reason: 'The model is turned off for this run (--no-llm).',
    });
    expect(byEnvironment.reason).toBe(
      'The model is turned off on this computer (LLM_PROVIDER=none).',
    );
    expect(byFlag.fix).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('reports an invalid model setting in the command’s words', async () => {
    const { resolve } = resolver(true);

    const result = await read([], resolve, { YANTRA_AGENT_MODEL: '' });

    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/Model/u);
    expect(findLeaf(result.fix!.path)).toBeDefined();
  });

  it('never returns a credential, whatever the environment holds', async () => {
    const { resolve } = resolver(false);

    const result = await read([], resolve, {
      ANTHROPIC_API_KEY: CANARY,
      YANTRA_AGENT_AUTH_SECRET: 'anthropic.work',
    });

    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(ProviderReadiness.safeParse(result).success).toBe(true);
  });

  it('names only registry commands as fixes', async () => {
    const leaves = new Set(
      COMMAND_REGISTRY.commands
        .filter((entry) => entry.kind === 'leaf')
        .map((entry) => entry.path.join(' ')),
    );
    const { resolve } = resolver(false);
    const results = await Promise.all([
      read([], resolve),
      read(['--auth-secret', 'k'], resolve),
      read([], resolve, { YANTRA_AGENT_MODEL: '' }),
    ]);

    for (const result of results) expect(leaves.has(result.fix!.path.join(' '))).toBe(true);
  });

  it('serves the read over RPC with the host environment', async () => {
    const methods = new RpcMethodRegistry();
    const { resolve } = resolver(true);
    const seen: NodeJS.ProcessEnv[] = [];
    registerMissionReads(methods, {
      resolve: () => Promise.resolve([]),
      env: { YANTRA_AGENT_PROVIDER: 'anthropic' },
      resolveAgent: (command, options, env) => {
        seen.push(env);
        return resolve(command, options, env);
      },
    });
    const method = methods.get('read.provider_readiness')!;

    const result = await Promise.resolve(
      method.handler(
        method.params.parse({ path: ['do'], argv: ['x'], cwd: CWD }),
        {} as RpcCallContext,
      ),
    );

    expect(result).toMatchObject({ ready: true, provider: 'anthropic' });
    expect(seen[0]?.YANTRA_AGENT_PROVIDER).toBe('anthropic');
  });
});
