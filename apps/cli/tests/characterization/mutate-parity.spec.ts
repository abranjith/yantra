import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type * as CoreModule from '@yantra/core';
import {
  resetPathCache,
  configPath,
  withResourceLock,
  type BrowserRuntimeServices,
  type ManagedInstallService,
  type ManagedUpdateService,
} from '@yantra/core';
import { createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

import { normalize, snapshotTree } from './harness.js';

vi.mock('@yantra/core', async (importActual) => ({
  ...(await importActual<typeof CoreModule>()),
  createKeychainProvider: () =>
    Promise.resolve({
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve([]),
      isAvailable: () => Promise.resolve(false),
    }),
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-mutation-parity-'));
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const workflow =
  'version: 1\nname: fixture\ndescription: Fixture\nsecurity_class: public\nparams: {}\nsecrets: []\ncookies: none\nsteps:\n  - id: s1\n    verb: navigate\n    url: https://fixture.example\n    scope: null\noutputs: []\n';
export const mutateCases: readonly (readonly string[])[] = [
  ['config', 'set', 'browser.source', 'auto'],
  ['config', 'unset', 'browser.source'],
  ['model', 'add', 'fixture', '--provider', 'anthropic'],
  ['model', 'default', 'fixture'],
  ['model', 'rm', 'fixture', '--force'],
  ['prefs', 'set', 'defaults.detail', 'full'],
  ['prefs', 'approve', 'defaults.detail'],
  ['prefs', '--forget', 'defaults.detail'],
  ['sites', 'add', 'fixture.example'],
  ['sites', 'list'],
  ['sites', 'remove', 'fixture.example'],
  ['template', 'new', 'fixture'],
  ['template', 'lint', 'fixture'],
  ['template', 'save', 'template.md', '--name', 'saved'],
  ['template', 'remove', 'fixture'],
  ['lint', 'workflow.yaml'],
  ['browser', 'use', 'auto'],
  ['browser', 'install', '--yes'],
  ['browser', 'update'],
  ['browser', 'check'],
  ['open', 'missing', '--print'],
];
const unavailable = {
  code: 'no-browser',
  message: 'No fixture browser.',
  remediation: 'Install a browser.',
};
const failure = {
  code: 'network-failure',
  phase: 'downloading',
  detail: 'Transfer failed.',
  remediation: 'Retry.',
  retainedOrphan: null,
};
const options: CliRunOptions = {
  browserRuntime: {
    services: {
      resolver: { resolve: async () => ({ status: 'unavailable', error: unavailable }) },
    } as unknown as BrowserRuntimeServices,
    service: {
      install: async () => ({ status: 'failed', error: failure }),
    } as unknown as ManagedInstallService,
    updateService: {
      preflightMutation: async () => ({ status: 'refused', error: failure }),
    } as unknown as ManagedUpdateService,
  },
};
async function surface(home: string, worker: boolean, argv: readonly string[]) {
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
  const env = { YANTRA_HOME: home };
  let stdout = '',
    stderr = '',
    envelope: unknown = null;
  const path =
    argv[0] === 'prefs' || argv[0] === 'lint' || argv[0] === 'open' ? [argv[0]!] : argv.slice(0, 2);
  if (worker) {
    const channel = new InMemoryChannel();
    const result = await runWorkerInvocation(
      {
        invocation_id: createInvocationId(),
        cwd: home,
        path: [...path],
        argv: argv.slice(path.length),
      },
      channel,
      env,
      options,
    );
    return {
      code: result.exit_code,
      stderr: channel.diagnostics.join(''),
      stdout: result.type === 'result' ? (result.text ?? '') : '',
      envelope: result.type === 'result' ? result.envelope : null,
    };
  }
  const context = createTerminalContext({
    env,
    cwd: home,
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
  const result = await executeCommand(
    argv,
    {
      ...context,
      output: {
        ...context.output,
        json: (v) => {
          envelope = v;
        },
      },
    },
    options,
  );
  return { code: result.exitCode, stderr, stdout, envelope };
}
describe('@no-llm mutation adapter parity', () => {
  it.each([false, true])(
    'matches output and durable artifacts json=%s',
    async (json) => {
      const surfaces: unknown[][] = [];
      for (const worker of [false, true]) {
        const home = join(root, worker ? 'worker' : 'terminal');
        await mkdir(home, { recursive: true });
        await writeFile(join(home, 'workflow.yaml'), workflow);
        await writeFile(
          join(home, 'template.md'),
          '---\nname: saved\ntags: []\n---\n# {{ title | text }}\n\n{{ sources }}\n',
        );
        const results: unknown[] = [];
        for (const command of mutateCases) {
          const result = await surface(home, worker, [...command, ...(json ? ['--json'] : [])]);
          if (!['browser', 'open'].includes(command[0]!)) expect(result.code).toBe(0);
          results.push(
            JSON.parse(
              normalize(JSON.stringify({ command, result, tree: await snapshotTree(home) }), home),
            ) as unknown,
          );
        }
        surfaces.push(results);
      }
      for (let index = 0; index < mutateCases.length; index++)
        expect(surfaces[1]?.[index]).toEqual(surfaces[0]?.[index]);
    },
    60000,
  );
  it('routes attended install consent and cancellation through the channel', async () => {
    const home = join(root, 'install');
    await mkdir(home);
    vi.stubEnv('YANTRA_HOME', home);
    resetPathCache();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const channel = new InMemoryChannel({ attended: true, installs: [true] });
    const running = runWorkerInvocation(
      {
        invocation_id: createInvocationId(),
        cwd: home,
        path: ['browser', 'install'],
        argv: ['--json'],
      },
      channel,
      { YANTRA_HOME: home },
      {
        browserRuntime: {
          service: {
            install: async (request) => {
              started();
              await new Promise<void>((resolve) => {
                if (request.signal?.aborted) resolve();
                else request.signal?.addEventListener('abort', () => resolve(), { once: true });
              });
              return { status: 'cancelled', at: 'downloading', retainedOrphan: null };
            },
          } as ManagedInstallService,
        },
      },
    );
    await ready;
    channel.cancel();
    const result = await running;
    expect(channel.installs).toHaveLength(1);
    expect(result.exit_code).toBe(4);
    expect(channel.diagnostics).not.toContain('cancel_unsupported');
  });
  it('refuses secure and terminal-only worker commands without artifacts', async () => {
    const home = join(root, 'refused');
    await mkdir(home);
    for (const argv of [
      ['secret', 'set', 'tavily.api_key'],
      ['secret', 'rm', 'tavily.api_key'],
      ['secret', 'list'],
      ['config', 'data-dir'],
    ])
      expect((await surface(home, true, argv)).code).toBe(1);
    const edit = await surface(home, true, ['config', 'edit']);
    expect(edit.code).toBe(1);
    expect(edit.stderr).toContain("app's raw-YAML editor");
    expect(await snapshotTree(home)).toEqual({});
  });
  it('maps a held config lock to equal busy envelopes', async () => {
    const home = join(root, 'busy');
    await mkdir(home);
    vi.stubEnv('YANTRA_HOME', home);
    resetPathCache();
    await withResourceLock(
      { kind: 'config' },
      async () => {
        const terminal = await surface(home, false, [
          'config',
          'set',
          'browser.source',
          'auto',
          '--json',
        ]);
        const worker = await surface(home, true, [
          'config',
          'set',
          'browser.source',
          'auto',
          '--json',
        ]);
        expect(worker).toEqual(terminal);
        expect(worker.code).toBe(3);
      },
      { targetPath: configPath() },
    );
  }, 20000);
});
