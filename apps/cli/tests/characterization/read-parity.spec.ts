import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import type * as CoreModule from '@yantra/core';
import { resetPathCache, runsRoot, workflowsRoot } from '@yantra/core';
import { createInvocationId } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTerminalContext } from '../../src/adapters/terminal/terminal-adapter.js';
import { InMemoryChannel } from '../../src/adapters/worker/in-memory-channel.js';
import { runWorkerInvocation } from '../../src/adapters/worker/worker-adapter.js';
import { executeCommand } from '../../src/execute.js';
import type { CliRunOptions } from '../../src/program.js';

import { normalize } from './harness.js';

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
  root = await mkdtemp(join(tmpdir(), 'yantra-read-parity-'));
});
afterEach(async () => {
  resetPathCache();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
const cases: readonly (readonly [readonly string[], readonly string[]])[] = [
  [['list'], ['workflows']],
  [['list'], ['runs']],
  [['show'], ['fixture', '--workflow']],
  [['show'], ['run-fixed', '--run']],
  [['audit'], ['run-fixed']],
  [['report'], ['run-fixed']],
  [['usage'], []],
  [['profile'], []],
  [['doctor'], ['--no-llm']],
  [['config', 'path'], []],
  [['config', 'list'], []],
  [['config', 'get'], ['browser.source']],
  [['config', 'validate'], []],
  [['model', 'list'], []],
  [['sites', 'list'], []],
  [['template', 'list'], []],
  [['template', 'show'], ['fixture']],
  [['browser', 'list'], []],
  [['prefs'], ['list']],
  [['prefs'], ['get', 'defaults.detail']],
];
const options: CliRunOptions = {
  doctorRuntime: {
    coreDoctor: () =>
      Promise.resolve({
        generatedAt: '2026-11-07T00:00:00.000Z',
        cachedFrom: null,
        overall: 'ok',
        checks: [],
      }),
    agentDiagnostics: () => Promise.resolve([]),
    loadPreferences: () => Promise.resolve(new Map()),
  },
};
const workflow =
  'version: 1\nname: fixture\ndescription: Read parity fixture\nsecurity_class: public\nparams: {}\nsecrets: []\ncookies: none\nsteps:\n  - id: s1\n    verb: navigate\n    url: https://fixture.example\n    scope: null\noutputs: []\n';
async function prepare(home: string, populated: boolean) {
  vi.stubEnv('YANTRA_HOME', home);
  resetPathCache();
  await mkdir(home, { recursive: true });
  if (!populated) return;
  await mkdir(workflowsRoot(), { recursive: true });
  await writeFile(join(workflowsRoot(), 'fixture.yaml'), workflow);
  const runDir = join(runsRoot(), 'run-fixed');
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      runId: 'run-fixed',
      taskId: '01J00000000000000000000000',
      workflowName: 'fixture',
      workflowVersion: 1,
      status: 'completed',
      startedAt: '2026-11-07T00:00:00.000Z',
      endedAt: '2026-11-07T00:00:01.000Z',
      durationMs: 1000,
      profileKind: 'ephemeral',
      cookieProfilePath: null,
      params: {},
      outputBindingNames: [],
    }),
  );
  await writeFile(join(runDir, 'report.md'), '# Fixture report\n\nSaved result.\n');
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const context = createTerminalContext({
    env: { YANTRA_HOME: home, LLM_PROVIDER: 'none' },
    cwd: root,
    isTty: false,
    stdout: sink,
    stderr: sink,
  });
  for (const argv of [
    ['model', 'add', 'fixture-model', '--provider', 'anthropic'],
    ['prefs', 'set', 'defaults.detail', 'full'],
    ['sites', 'add', 'fixture.example'],
    ['template', 'new', 'fixture'],
  ])
    expect((await executeCommand(argv, context)).exitCode).toBe(0);
}
describe('@no-llm read command adapter parity', () => {
  it.each([false, true])(
    'matches human and JSON reads in populated=%s homes',
    async (populated) => {
      const surfaces: unknown[][] = [];
      for (const surface of ['terminal', 'worker'] as const) {
        const home = join(root, surface);
        await prepare(home, populated);
        const snapshots: unknown[] = [];
        for (const [path, args] of cases)
          for (const json of [false, true]) {
            const argv = [...args, ...(json ? ['--json'] : [])];
            let stdout = '',
              stderr = '',
              envelope: unknown = null;
            let code: number;
            const env = { YANTRA_HOME: home, LLM_PROVIDER: 'none' };
            if (surface === 'terminal') {
              const context = createTerminalContext({
                env,
                cwd: root,
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
              const original = context.output.json;
              let jsonBytes = '';
              code = (
                await executeCommand(
                  [...path, ...argv],
                  {
                    ...context,
                    output: {
                      ...context.output,
                      json: (value, format) => {
                        envelope = value;
                        jsonBytes += `${JSON.stringify(value, null, format?.indent)}\n`;
                        original(value, format);
                      },
                    },
                  },
                  options,
                )
              ).exitCode;
              if (jsonBytes) stdout = stdout.replace(jsonBytes, '');
              if (json && envelope === null && stdout.trim()) {
                envelope = JSON.parse(stdout) as unknown;
                stdout = '';
              }
            } else {
              const channel = new InMemoryChannel();
              const result = await runWorkerInvocation(
                { invocation_id: createInvocationId(), cwd: root, path: [...path], argv },
                channel,
                env,
                options,
              );
              code = result.exit_code;
              stderr = channel.diagnostics.join('');
              if (result.type === 'result') {
                envelope = result.envelope;
                stdout = result.text ?? '';
              }
            }
            if (json && code === 0) expect(envelope).not.toBeNull();
            snapshots.push({
              command: [...path, ...argv],
              value: normalize(JSON.stringify({ code, stdout, stderr, envelope }), home),
            });
          }
        surfaces.push(snapshots);
      }
      expect(surfaces[1]).toEqual(surfaces[0]);
    },
    60_000,
  );
});
