import { Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { executeCommand } from '../../src/execute.js';

describe('@no-llm foreground daemon cancellation', () => {
  it('awaits the context signal, stops once and releases handles', async () => {
    const controller = new AbortController();
    let stdout = '',
      stderr = '';
    const context = createTerminalContext({
      env: {},
      signal: controller.signal,
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
    const close = vi.fn();
    const stop = vi.fn(() => Promise.resolve());
    const result = await executeCommand(['daemon', 'start', '--foreground'], context, {
      daemonRuntime: {
        build: () =>
          Promise.resolve({
            daemon: {
              start: () => {
                controller.abort('SIGTERM');
                return Promise.resolve();
              },
              stop,
              status: () =>
                Promise.resolve({
                  running: true,
                  pid: 17,
                  schedulesLoaded: 0,
                  nextFires: [],
                  pendingConfirmations: 0,
                }),
            },
            close,
          }),
      },
    });
    expect(result.exitCode).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(stdout).toContain('Scheduler daemon running');
    expect(stderr).toContain('Received SIGTERM, shutting down');
  });
});
