import { Writable } from 'node:stream';

import type { AgenticTaskDependencies, AgenticTaskOutcome } from '@yantra/agent';
import { InteractiveInstallOfferGateway } from '@yantra/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import { registerAskCommand, type AskRuntime } from '../../src/commands/ask.js';

const failedOutcome: AgenticTaskOutcome = {
  kind: 'failed',
  runId: 'browser-offer-test',
  runDir: 'browser-offer-test',
  error: { code: 'AGENT_AUTH_UNAVAILABLE', message: 'fixture' },
};

function sink(): NodeJS.WritableStream {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

async function invoke(argv: readonly string[], isTty: boolean): Promise<AgenticTaskDependencies> {
  let dependencies: AgenticTaskDependencies | undefined;
  const runTask: AskRuntime['runTask'] = vi.fn((_request, supplied) => {
    dependencies = supplied ?? {};
    return Promise.resolve(failedOutcome);
  });
  const program = new Command().exitOverride();
  registerAskCommand(program, {
    env: {},
    stdout: sink(),
    stderr: sink(),
    isTty,
    createPipeline: vi.fn() as never,
    resolveDefaults: () => Promise.resolve(new Map()),
    recordHistory: () => Promise.resolve(),
    runTask,
    resolveAgent: (command, options, env, prefs) =>
      resolveAgentInvocation(command, options, env, prefs, {
        probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
      }),
  });

  await program.parseAsync([...argv], { from: 'user' }).catch(() => undefined);
  return dependencies ?? {};
}

describe('@no-llm browser install offer CLI boundary', () => {
  it('injects a human-only gateway for an interactive non-JSON invocation', async () => {
    const dependencies = await invoke(['ask', 'find a browser'], true);

    expect(dependencies.browserInstallOfferGateway).toBeInstanceOf(InteractiveInstallOfferGateway);
  });

  it.each([
    { argv: ['ask', 'find a browser', '--json'], isTty: true },
    { argv: ['ask', 'find a browser'], isTty: false },
  ])('injects no gateway for unattended or JSON invocation', async ({ argv, isTty }) => {
    const dependencies = await invoke(argv, isTty);

    expect(dependencies.browserInstallOfferGateway).toBeNull();
  });
});
