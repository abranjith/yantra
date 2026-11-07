import { Writable } from 'node:stream';

import { ResourceBusyError } from '@yantra/core';
import { describe, expect, it } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { CommandFailure } from '../../src/context/command-context.js';
import { executeCommand } from '../../src/execute.js';

function harness(tty = false) {
  let stdout = '',
    stderr = '';
  const context = createTerminalContext({
    env: {},
    isTty: tty,
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
  return { context, out: () => stdout, err: () => stderr };
}
describe('@no-llm terminal adapter', () => {
  it('requires attendance and ordinary output for interaction', () => {
    expect(harness().context.isInteractive({})).toBe(false);
    const h = harness(true);
    expect(h.context.isInteractive({ json: false })).toBe(true);
    expect(h.context.isInteractive({ json: true })).toBe(false);
  });
  it('routes recursive help and parse errors to supplied sinks', async () => {
    const h = harness();
    expect(await executeCommand(['research', '--help'], h.context)).toEqual({ exitCode: 0 });
    expect(h.out()).toContain('Usage: yantra research');
    expect(h.err()).toBe('');
    expect((await executeCommand(['research', '--bad'], h.context)).exitCode).not.toBe(0);
    expect(h.err()).toContain("unknown option '--bad'");
  });
  it('maps safe failures without changing their exit codes, including cancellation', async () => {
    for (const code of [1, 2, 3, 4, 130] as const) {
      const h = harness();
      expect(
        await executeCommand(
          ['research', 'x'],
          h.context,
          {},
          {
            research: () => {
              throw new CommandFailure(code, 'fixture', 'safe failure');
            },
          },
        ),
      ).toEqual({ exitCode: code });
      expect(h.err()).toBe('safe failure\n');
    }
  });
  it('maps contention to the busy JSON envelope and exit 3', async () => {
    const h = harness();
    expect(
      await executeCommand(
        ['research', 'x', '--json'],
        h.context,
        {},
        {
          research: () => {
            throw new ResourceBusyError({ kind: 'config' }, null);
          },
        },
      ),
    ).toEqual({ exitCode: 3 });
    expect(JSON.parse(h.out())).toMatchObject({
      status: 'busy',
      resource: { kind: 'config' },
      holder: null,
    });
    expect(h.err()).toBe('');
  });
});
