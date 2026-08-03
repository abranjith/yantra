import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import { registerDoCommand } from '../../src/commands/do.js';

const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });

describe('@no-llm yantra do orchestrator chaos mapping', () => {
  it.each([
    {
      kind: 'failed',
      error: { code: 'AGENT_PROVIDER_UNAVAILABLE', message: 'provider crashed' },
      expected: 2,
    },
    {
      kind: 'budget_exhausted',
      error: { code: 'AGENT_BUDGET_EXHAUSTED', message: 'tool timed out' },
      expected: 2,
    },
    {
      kind: 'aborted',
      error: { code: 'AGENT_ABORTED', message: 'event storm interrupted' },
      expected: 130,
    },
  ] as const)('terminates cleanly for $kind', async (scenario) => {
    const terminal = {
      kind: scenario.kind,
      runId: 'run-chaos',
      runDir: '/runs/run-chaos',
      error: scenario.error,
    } as AgenticTaskOutcome;
    const runTask = vi.fn((request: AgenticTaskRequest) => {
      request.connector.renderAgentOutcome(terminal);
      return Promise.resolve(terminal);
    });
    const program = new Command().exitOverride();
    registerDoCommand(program, {
      runTask,
      env: {},
      stdout: sink,
      stderr: sink,
      isTty: false,
      resolveAgent: (command, options, env, prefs) =>
        resolveAgentInvocation(command, options, env, prefs, {
          probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
        }),
    });

    let exitCode = 0;
    try {
      await program.parseAsync(['do', 'chaos goal'], { from: 'user' });
    } catch (error) {
      exitCode = (error as { exitCode?: number }).exitCode ?? 2;
    }

    expect(exitCode).toBe(scenario.expected);
    expect(runTask).toHaveBeenCalledTimes(1);
  });
});
