import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { resetPathCache, defaultsFor } from '@yantra/core';
import { createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';

import { normalize, snapshotTree } from './harness.js';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-init-parity-'));
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
describe('@no-llm initialization adapter parity', () => {
  it.each([false, true])('retains default provider and reset files json=%s', async (json) => {
    const results: unknown[][] = [];
    for (const worker of [false, true]) {
      const home = join(root, worker ? 'worker' : 'terminal');
      await mkdir(home);
      vi.stubEnv('YANTRA_HOME', home);
      resetPathCache();
      const surface: unknown[] = [];
      for (const args of [
        [],
        ['--reset', '--provider', 'anthropic'],
        ['--reset', '--provider', 'ollama'],
        ['--provider', 'none'],
      ]) {
        const argv = [...args, ...(json ? ['--json'] : [])];
        let stdout = '',
          stderr = '',
          envelope: unknown = null;
        let code: number;
        if (worker) {
          const channel = new InMemoryChannel();
          const result = await runWorkerInvocation(
            { invocation_id: createInvocationId(), cwd: home, path: ['init'], argv },
            channel,
            { YANTRA_HOME: home },
          );
          code = result.exit_code;
          stderr = channel.diagnostics.join('');
          if (result.type === 'result') {
            stdout = result.text ?? '';
            envelope = result.envelope;
          }
        } else {
          const context = createTerminalContext({
            cwd: home,
            env: { YANTRA_HOME: home },
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
          code = (
            await executeCommand(['init', ...argv], {
              ...context,
              output: {
                ...context.output,
                json: (v) => {
                  envelope = v;
                },
              },
            })
          ).exitCode;
        }
        expect(code).toBe(0);
        const tree = await snapshotTree(home);
        const stable = Object.fromEntries(
          Object.entries(tree).map(([key, value]) => [
            key.replace(/\.bak\.\d+/u, '.bak.<time>'),
            value,
          ]),
        );
        surface.push(
          JSON.parse(
            normalize(JSON.stringify({ code, stdout, stderr, envelope, tree: stable }), home),
          ) as unknown,
        );
      }
      results.push(surface);
    }
    expect(results[1]).toEqual(results[0]);
  });
  it('collects attended worker onboarding answers through the channel', async () => {
    const home = join(root, 'attended');
    await mkdir(home);
    vi.stubEnv('YANTRA_HOME', home);
    resetPathCache();
    const channel = new InMemoryChannel({ attended: true, inputs: ['none', 'skip', '', false] });
    const result = await runWorkerInvocation(
      { invocation_id: createInvocationId(), cwd: home, path: ['init'], argv: [] },
      channel,
      { YANTRA_HOME: home },
    );
    expect(result.exit_code).toBe(0);
    expect(channel.inputs.map((v) => v.kind)).toEqual(['select', 'select', 'text', 'confirm']);
    const actual = await snapshotTree(home);
    expect(actual['profile.yaml']).toContain('location: false');
    const terminalHome = join(root, 'terminal');
    await mkdir(terminalHome);
    vi.stubEnv('YANTRA_HOME', terminalHome);
    resetPathCache();
    const sink = new Writable({
      write(_c, _e, cb) {
        cb();
      },
    });
    const context = createTerminalContext({
      cwd: terminalHome,
      isTty: true,
      env: { YANTRA_HOME: terminalHome },
      stdout: sink,
      stderr: sink,
    });
    expect(
      (
        await executeCommand(['init'], {
          ...context,
          initAnswers: {
            providerAnswers: async () => defaultsFor('none'),
            contextGrants: async () => ({
              grants: { location: false, screenshots: false },
              city: null,
            }),
          },
        })
      ).exitCode,
    ).toBe(0);
    expect(await snapshotTree(terminalHome)).toEqual(actual);
  });
});
