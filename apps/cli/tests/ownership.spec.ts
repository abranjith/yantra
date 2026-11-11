// @no-llm
/**
 * The run-start sweep starts for `run`-class commands only, in the shared
 * execution path both adapters use (FEAT-064 TASK-010).
 */

import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../src/execute.js';
import type { RunStartSweep } from '../src/ownership.js';

function context() {
  const sink = () =>
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  return createTerminalContext({
    env: {},
    signal: new AbortController().signal,
    isTty: false,
    stdout: sink(),
    stderr: sink(),
  });
}

function sweepSpy(): { start: () => RunStartSweep; order: string[] } {
  const order: string[] = [];
  return {
    order,
    start: () => {
      order.push('sweep-started');
      return {
        settle: () => {
          order.push('sweep-settled');
          return Promise.resolve();
        },
      };
    },
  };
}

describe('@no-llm run-start sweep in executeCommand', () => {
  it('starts before a run-class handler and settles after it', async () => {
    const spy = sweepSpy();
    const research = vi.fn(() => {
      spy.order.push('handler');
      return Promise.resolve({ exitCode: 0 } as const);
    });
    const result = await executeCommand(
      ['research', '--no-llm', 'compare espresso grinders'],
      context(),
      { runStartSweep: spy.start },
      { research },
    );
    expect(result.exitCode).toBe(0);
    expect(spy.order).toEqual(['sweep-started', 'handler', 'sweep-settled']);
  });

  it('settles the sweep even when the handler throws', async () => {
    const spy = sweepSpy();
    await executeCommand(
      ['research', '--no-llm', 'x'],
      context(),
      { runStartSweep: spy.start },
      {
        research: () => Promise.reject(new Error('boom')),
      },
    ).catch(() => undefined);
    expect(spy.order).toEqual(['sweep-started', 'sweep-settled']);
  });

  it('does not sweep for a read-class command', async () => {
    const spy = sweepSpy();
    await executeCommand(
      ['list', 'workflows'],
      context(),
      { runStartSweep: spy.start },
      {
        list: () => Promise.resolve({ exitCode: 0 } as const),
      },
    );
    expect(spy.order).toEqual([]);
  });

  it('can be disabled', async () => {
    const research = vi.fn(() => Promise.resolve({ exitCode: 0 } as const));
    const result = await executeCommand(
      ['research', '--no-llm', 'x'],
      context(),
      {
        runStartSweep: null,
      },
      { research },
    );
    expect(result.exitCode).toBe(0);
    expect(research).toHaveBeenCalledOnce();
  });
});
