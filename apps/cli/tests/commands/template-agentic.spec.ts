import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest, ActiveReportTemplate } from '@yantra/agent';
import { parseTemplate } from '@yantra/core';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { resolveAgentInvocation } from '../../src/agent-options.js';
import { registerAskCommand } from '../../src/commands/ask.js';
import { registerDoCommand } from '../../src/commands/do.js';
import { registerResearchCommand } from '../../src/commands/research.js';
import { TEMPLATE_LLM_GUARD } from '../../src/template-ref.js';

function capture() {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += String(chunk);
        callback();
      },
    }),
    value: () => value,
  };
}

function resolvedTemplate(): ActiveReportTemplate {
  const parsed = parseTemplate(
    '# {{ title | text }}\n\n## Summary\n{{ summary }}\n\n{{ sources }}',
  );
  if (!parsed.isOk) throw new Error('fixture template did not parse');
  return { manifest: parsed.value, source: 'saved', path: null, name: 'fixture' };
}

const failed: AgenticTaskOutcome = {
  kind: 'failed',
  runId: 'run-1',
  runDir: '/runs/run-1',
  error: { code: 'AGENT_TOOL_FAILED', message: 'fixture stop' },
};

async function parseGuard(command: 'ask' | 'research' | 'do') {
  const stdout = capture();
  const stderr = capture();
  const program = new Command().exitOverride();
  const shared = {
    env: {},
    stdout: stdout.stream,
    stderr: stderr.stream,
    isTty: false,
    runTask: vi.fn(() => Promise.resolve(failed)),
    resolveAgent: (
      command: string,
      options: Parameters<typeof resolveAgentInvocation>[1],
      env: NodeJS.ProcessEnv,
      prefs: Parameters<typeof resolveAgentInvocation>[3],
    ) =>
      resolveAgentInvocation(command, options, env, prefs, {
        probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
      }),
  };
  if (command === 'ask') {
    registerAskCommand(program, {
      ...shared,
      resolveDefaults: () => Promise.resolve(new Map()),
      recordHistory: () => Promise.resolve(),
    });
  } else if (command === 'research') registerResearchCommand(program, shared);
  else registerDoCommand(program, shared);
  await expect(
    program.parseAsync([command, 'goal', '--no-llm', '--template', 'weekly'], { from: 'user' }),
  ).rejects.toMatchObject({ exitCode: 1 });
  return stderr.value();
}

describe('@no-llm agentic template command wiring', () => {
  it('uses the identical non-LLM guard on ask, research, and do', async () => {
    for (const command of ['ask', 'research', 'do'] as const) {
      expect(await parseGuard(command)).toContain(TEMPLATE_LLM_GUARD);
    }
  });

  it.each(['ask', 'research', 'do'] as const)(
    'passes a resolved template to %s runtime',
    async (command) => {
      const stdout = capture();
      const stderr = capture();
      const request = { current: undefined as AgenticTaskRequest | undefined };
      const runTask = vi.fn((input: AgenticTaskRequest) => {
        request.current = input;
        return Promise.resolve(failed);
      });
      const program = new Command().exitOverride();
      const shared = {
        env: {},
        stdout: stdout.stream,
        stderr: stderr.stream,
        isTty: false,
        resolveTemplate: () => Promise.resolve(resolvedTemplate()),
        runTask,
        resolveAgent: (
          resolvedCommand: string,
          options: Parameters<typeof resolveAgentInvocation>[1],
          env: NodeJS.ProcessEnv,
          prefs: Parameters<typeof resolveAgentInvocation>[3],
        ) =>
          resolveAgentInvocation(resolvedCommand, options, env, prefs, {
            probeCredential: () => Promise.resolve({ available: true, authSource: 'environment' }),
          }),
      };
      if (command === 'ask') {
        registerAskCommand(program, {
          ...shared,
          resolveDefaults: () => Promise.resolve(new Map()),
          recordHistory: () => Promise.resolve(),
        });
      } else if (command === 'research') registerResearchCommand(program, shared);
      else registerDoCommand(program, shared);

      await expect(
        program.parseAsync([command, 'goal', '--template', 'weekly'], { from: 'user' }),
      ).rejects.toMatchObject({ exitCode: 2 });
      expect(request.current?.template?.name).toBe('fixture');
    },
  );
});
