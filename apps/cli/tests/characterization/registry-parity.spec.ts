import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type * as CoreModule from '@yantra/core';
import { resetPathCache, type BrowserRuntimeServices } from '@yantra/core';
import { COMMAND_REGISTRY, createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

import { normalize } from './harness.js';
import { actionScenarios } from './scenarios.js';

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
const rows: readonly (readonly string[])[] = [
  ...actionScenarios.map(([, argv]) =>
    argv[0] === 'resume'
      ? ['resume', 'fixture']
      : argv[0] === 'browser' && argv[1] === 'check'
        ? ['browser', 'check', '--browser', 'system', '--browser-path', '/fixture/browser']
        : argv,
  ),
  ['config', 'edit'],
  ['secret', 'rm', 'fixture'],
  ['secret', 'list'],
  ['lint', 'missing.yaml'],
  ['browser', 'list'],
  ['daemon', 'start', '--foreground'],
  // FEAT-065: an exemption (D15), so only the worker refusal is asserted.
  ['ui', '--print'],
];
const leaves = COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'leaf');
const entryFor = (argv: readonly string[]) =>
  leaves.find((entry) => entry.path.every((part, index) => argv[index] === part));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'yantra-registry-parity-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetPathCache();
  await rm(root, { recursive: true, force: true });
});
const options: CliRunOptions = {
  researchRuntime: {
    resolveDefaults: async () => new Map(),
    createLoop: async () => {
      throw new Error('Fixture loop unavailable.');
    },
  },
  askRuntime: {
    resolveDefaults: async () => new Map(),
    createPipeline: async () => {
      throw new Error('Fixture pipeline unavailable.');
    },
  },
  browserRuntime: {
    services: {
      resolver: {
        resolve: async () => ({
          status: 'unavailable',
          error: {
            code: 'no-browser',
            message: 'Fixture browser unavailable.',
            remediation: 'Install one.',
          },
        }),
      },
    } as unknown as BrowserRuntimeServices,
  },
  daemonRuntime: {
    build: async () => ({
      daemon: {
        start: async () => {
          throw new Error('Fixture daemon start failed.');
        },
        stop: async () => undefined,
        status: async () => ({
          running: false,
          pid: null,
          schedulesLoaded: 0,
          nextFires: [],
          pendingConfirmations: 0,
        }),
      },
      close: () => undefined,
    }),
  },
};
describe('@no-llm registry-wide adapter parity census', () => {
  it('enumerates every registered command path and requires an executable or refusal row', () => {
    expect([...new Set(rows.map((row) => entryFor(row)?.path.join(' ')))].sort()).toEqual(
      leaves.map((entry) => entry.path.join(' ')).sort(),
    );
    // Groups have no executable body; their generated help is covered by terminal-baseline.
    const groups = COMMAND_REGISTRY.commands.filter((entry) => entry.kind === 'group');
    expect([...groups, ...leaves].map((entry) => entry.path.join(' ')).sort()).toEqual(
      COMMAND_REGISTRY.commands.map((entry) => entry.path.join(' ')).sort(),
    );
  });
  it('executes each table row on both adapters or asserts its worker refusal', async () => {
    const snapshots: unknown[][] = [[], []];
    for (const worker of [false, true]) {
      const home = join(root, worker ? 'worker' : 'terminal');
      await mkdir(home);
      vi.stubEnv('YANTRA_HOME', home);
      resetPathCache();
      for (const argv of rows) {
        const entry = entryFor(argv)!;
        const refusal =
          entry.execution.default === 'exemption' ||
          entry.execution.default === 'in-process-secure';
        if (!worker && (refusal || entry.id === 'config.edit')) continue;
        let stdout = '',
          stderr = '',
          envelope: unknown = null;
        let code: number;
        if (worker) {
          const channel = new InMemoryChannel();
          const result = await runWorkerInvocation(
            {
              invocation_id: createInvocationId(),
              cwd: home,
              path: [...entry.path],
              argv: argv.slice(entry.path.length),
            },
            channel,
            { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
            options,
          );
          code = result.exit_code;
          stderr = channel.diagnostics.join('');
          if (result.type === 'result') {
            stdout = result.text ?? '';
            envelope = result.envelope;
          }
          if (refusal) {
            expect(result).toMatchObject({
              type: 'error',
              exit_code: 1,
              code: 'not_worker_executable',
            });
            continue;
          }
          if (entry.id === 'config.edit') {
            expect(code).toBe(1);
            expect(stderr).toContain("app's raw-YAML editor");
            continue;
          }
        } else {
          const context = createTerminalContext({
            cwd: home,
            env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
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
            await executeCommand(
              argv,
              {
                ...context,
                output: {
                  ...context.output,
                  json: (value) => {
                    envelope = value;
                  },
                },
              },
              options,
            )
          ).exitCode;
          if (argv.includes('--json') && envelope === null && stdout.trim()) {
            envelope = JSON.parse(stdout) as unknown;
            stdout = '';
          }
        }
        snapshots[worker ? 1 : 0]!.push({
          command: argv,
          value: normalize(JSON.stringify({ code, stdout, stderr, envelope }), home),
        });
      }
    }
    for (let index = 0; index < snapshots[0]!.length; index++)
      expect(snapshots[1]![index]).toEqual(snapshots[0]![index]);
  }, 60000);
});
