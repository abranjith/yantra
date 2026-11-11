import { Writable } from 'node:stream';

import type { ResearchLoop } from '@yantra/core';
import { createInvocationId } from '@yantra/protocol';
import { canonicalBrief } from '@yantra/test-helpers';
import { describe, expect, it } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

describe('@no-llm adapter parity', () => {
  it.each([false, true])('research deterministic output (JSON=%s)', async (json) => {
    let stdout = '',
      stderr = '';
    const context = createTerminalContext({
      env: { LLM_PROVIDER: 'none' },
      cwd: 'C:/fixture',
      isTty: false,
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
    const options: CliRunOptions = {
      runStartSweep: null,
      researchRuntime: {
        resolveDefaults: () => Promise.resolve(new Map()),
        createLoop: () =>
          Promise.resolve({
            run: () =>
              Promise.resolve({
                brief: canonicalBrief,
                artifacts: null,
                hops: [],
                terminationReason: 'max_hops',
              }),
          } as unknown as ResearchLoop),
      },
    };
    const argv = ['x', '--no-llm', ...(json ? ['--json'] : [])];
    const terminal = await executeCommand(['research', ...argv], context, options);
    const channel = new InMemoryChannel();
    const worker = await runWorkerInvocation(
      { invocation_id: createInvocationId(), cwd: context.cwd, path: ['research'], argv },
      channel,
      { LLM_PROVIDER: 'none' },
      options,
    );
    expect(worker.exit_code).toBe(terminal.exitCode);
    expect(channel.diagnostics.join('')).toBe(stderr);
    expect(worker.type).toBe('result');
    if (worker.type === 'result') {
      if (json) expect(worker.envelope).toEqual(JSON.parse(stdout));
      else expect(worker.text).toBe(stdout);
    }
  });
  it('a failing research loop retains the same diagnostic and execution exit', async () => {
    let stderr = '';
    const context = createTerminalContext({
      env: { LLM_PROVIDER: 'none' },
      isTty: false,
      stderr: new Writable({
        write(c, _e, cb) {
          stderr += String(c);
          cb();
        },
      }),
    });
    const options: CliRunOptions = {
      runStartSweep: null,
      researchRuntime: {
        resolveDefaults: () => Promise.resolve(new Map()),
        createLoop: () => Promise.reject(new Error('fixture failed')),
      },
    };
    const terminal = await executeCommand(['research', 'x', '--no-llm'], context, options);
    const channel = new InMemoryChannel();
    const worker = await runWorkerInvocation(
      {
        invocation_id: createInvocationId(),
        cwd: context.cwd,
        path: ['research'],
        argv: ['x', '--no-llm'],
      },
      channel,
      { LLM_PROVIDER: 'none' },
      options,
    );
    expect(worker.exit_code).toBe(terminal.exitCode);
    expect(worker.exit_code).toBe(2);
    expect(channel.diagnostics.join('')).toBe(stderr);
  });
});
