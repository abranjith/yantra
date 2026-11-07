import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type { AgenticTaskOutcome, AgenticTaskRequest } from '@yantra/agent';
import { resetPathCache, writeExecutionReceipt } from '@yantra/core';
import { createInvocationId, type ConfirmationRequest } from '@yantra/protocol';
import { canonicalBrief } from '@yantra/test-helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTerminalContext,
  runTerminal,
} from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { resolveAgentInvocation } from '../../src/agent-options.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

import { normalize } from './harness.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'yantra-agentic-parity-'));
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const request: ConfirmationRequest = {
  confirmation_id: '01J00000000000000000000000',
  run_id: 'run',
  step_id: 'step',
  action_kind: 'click',
  host: 'fixture.example',
  description: 'fixture action',
  expected_cost: null,
  consequence: 'reversible',
  requested_at: '2026-11-06T00:00:00.000Z',
  timeout_ms: 1000,
};
function published(runDir: string): AgenticTaskOutcome {
  return {
    kind: 'published',
    runId: 'run',
    runDir,
    brief: {
      kind: 'brief',
      briefId: 'brief',
      jsonPath: join(runDir, 'brief.json'),
      markdownPath: join(runDir, 'brief.md'),
      htmlPath: join(runDir, 'brief.html'),
    },
    taskOutcome: 'fulfilled',
    requirements: { met: 0, total: 0, unmet: [], contractDeclared: true },
    artifacts: [],
    captureSets: [],
    terminationReason: 'model_finished',
  };
}
describe('@no-llm agentic adapter parity', () => {
  it.each([
    ['ask', true, false],
    ['do', true, false],
    ['do', false, true],
    ['do', false, false],
  ] as const)(
    '%s JSON=%s attended=%s uses equal outputs and receipts',
    async (command, json, attended) => {
      const results: unknown[] = [];
      for (const surface of ['terminal', 'worker'] as const) {
        let stdout = '',
          stderr = '';
        const runDir = join(home, surface);
        await mkdir(runDir);
        await writeFile(join(runDir, 'brief.json'), JSON.stringify(canonicalBrief));
        const channel = new InMemoryChannel({ attended, confirmations: ['granted'] });
        const runTask = async (input: AgenticTaskRequest) => {
          await writeExecutionReceipt(runDir, input.receipt!);
          let outcome = published(runDir);
          if (command === 'do') {
            const decision = await input.connector.requestConfirmation(request, input.signal!);
            if (decision !== 'granted')
              outcome = {
                kind: 'handoff',
                runId: 'run',
                runDir,
                blocker: 'fixture consent',
                safestNextAction: 'approve',
                terminationReason: 'handoff',
              };
          }
          input.connector.renderAgentOutcome(outcome);
          return outcome;
        };
        const runtime = {
          runTask,
          recordHistory: () => Promise.resolve(),
          resolveDefaults: () => Promise.resolve(new Map()),
          resolveAgent: (
            name: string,
            opts: Parameters<typeof resolveAgentInvocation>[1],
            env: NodeJS.ProcessEnv,
            prefs: Parameters<typeof resolveAgentInvocation>[3],
          ) =>
            resolveAgentInvocation(name, opts, env, prefs, {
              probeCredential: () => Promise.resolve({ available: true, authSource: 'fixture' }),
            }),
        };
        const options: CliRunOptions =
          command === 'do' ? { doRuntime: runtime } : { askRuntime: runtime };
        const argv = ['fixture', ...(json ? ['--json'] : [])];
        let code: number;
        if (surface === 'terminal') {
          const context = createTerminalContext({
            env: {},
            cwd: home,
            isTty: attended,
            stdout: new Writable({
              write(c, _e, cb) {
                stdout += String(c);
                cb();
              },
            }),
            stderr: new Writable({
              write(c, _e, cb) {
                stderr += String(c);
                cb();
              },
            }),
          });
          const connector = context.connector;
          const scripted = {
            ...context,
            connector: (
              renderer: Parameters<typeof connector>[0],
              opts: Parameters<typeof connector>[1],
            ) =>
              connector(
                renderer,
                opts
                  ? { ...opts, confirmationPrompt: () => Promise.resolve('granted') }
                  : undefined,
              ),
          };
          code = (await executeCommand([command, ...argv], scripted, options)).exitCode;
        } else {
          const result = await runWorkerInvocation(
            { invocation_id: createInvocationId(), cwd: home, path: [command], argv },
            channel,
            {},
            options,
          );
          code = result.exit_code;
          stderr = channel.diagnostics.join('');
          stdout =
            result.type === 'result'
              ? result.envelope
                ? `${JSON.stringify(result.envelope)}\n`
                : (result.text ?? '')
              : '';
        }
        const receipt = JSON.parse(
          await readFile(join(runDir, 'execution-receipt.json'), 'utf8'),
        ) as Record<string, unknown>;
        results.push({
          code,
          stdout: normalize(stdout, runDir),
          stderr: normalize(stderr, runDir),
          receipt: {
            ...receipt,
            run_id: 'normalized',
            invoked_by: 'surface',
            invocation_id: null,
            written_at: 'time',
          },
        });
      }
      expect(results[1]).toEqual(results[0]);
    },
  );
  it.each(['do', 'ask'] as const)(
    'worker cancel and terminal SIGINT both abort %s with 130',
    async (command) => {
      const codes: number[] = [];
      for (const surface of ['terminal', 'worker'] as const) {
        const channel = new InMemoryChannel();
        const runTask = async (input: AgenticTaskRequest) => {
          const aborted = new Promise<void>((resolve) =>
            input.signal!.addEventListener('abort', () => resolve(), { once: true }),
          );
          if (surface === 'worker') channel.cancel();
          else process.emit('SIGINT');
          await aborted;
          const outcome: AgenticTaskOutcome = {
            kind: 'aborted',
            runId: 'run',
            runDir: home,
            error: { code: 'AGENT_ABORTED', message: 'Interrupted.' },
            terminationReason: 'user_abort',
          };
          input.connector.renderAgentOutcome(outcome);
          return outcome;
        };
        const options: CliRunOptions = {
          [command === 'do' ? 'doRuntime' : 'askRuntime']: {
            runTask,
            resolveDefaults: () => Promise.resolve(new Map()),
            resolveAgent: (name, opts, env, prefs) =>
              resolveAgentInvocation(name, opts, env, prefs, {
                probeCredential: () => Promise.resolve({ available: true, authSource: 'fixture' }),
              }),
          },
        };
        if (surface === 'terminal') {
          const sink = new Writable({
            write(_c, _e, cb) {
              cb();
            },
          });
          codes.push(
            await runTerminal([command, 'fixture'], options, {
              env: {},
              isTty: false,
              stdout: sink,
              stderr: sink,
            }),
          );
        } else
          codes.push(
            (
              await runWorkerInvocation(
                {
                  invocation_id: createInvocationId(),
                  cwd: home,
                  path: [command],
                  argv: ['fixture'],
                },
                channel,
                {},
                options,
              )
            ).exit_code,
          );
      }
      expect(codes).toEqual([130, 130]);
    },
  );
});
