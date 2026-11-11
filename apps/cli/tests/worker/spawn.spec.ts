// @no-llm
/**
 * The detached-worker spawn helper (FEAT-064 TASK-012, spike S2 RC1), with
 * real processes against the built `dist/` (run `npx turbo run build` first).
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { processExists } from '@yantra/core';
import { WorkerResult, generateUlid, type WorkerLaunch } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WORKER_LAUNCH_DIR_ENV } from '../../src/worker/launch.js';
import { WORKER_SPAWN_OPTIONS } from '../../src/worker/spawn-options.js';
import { resultFilePath, spawnDetachedWorker } from '../../src/worker/spawn.js';

const run = promisify(execFile);
const DIST = resolve(import.meta.dirname, '..', '..', 'dist');
const TRAMPOLINE = join(DIST, 'worker', 'trampoline.js');
const WORKER = join(DIST, 'worker.js');
const BUILT = existsSync(TRAMPOLINE) && existsSync(WORKER);

let dir: string;
const pids: number[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yantra-worker-spawn-'));
});
afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function launchFor(argv: readonly string[], path: readonly string[] = ['research']): WorkerLaunch {
  const id = generateUlid();
  return {
    schema_version: 1,
    invocation: { invocation_id: id, path: [...path], argv: [...argv], cwd: dir },
    result_path: resultFilePath(join(dir, 'launch'), id),
  };
}

async function commandLineOf(pid: number): Promise<string> {
  if (process.platform === 'win32') {
    const { stdout } = await run('powershell', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]);
    return stdout.trim();
  }
  if (process.platform === 'linux') {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  }
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  return stdout.trim();
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('@no-llm spawnDetachedWorker options', () => {
  it('spawns every worker with exactly these options', () => {
    expect(WORKER_SPAWN_OPTIONS).toEqual({
      detached: true,
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
  });

  it('starts the trampoline without a shell, a console window or inherited stdio', async () => {
    const calls: {
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }[] = [];
    const fakeSpawn = ((
      command: string,
      args: readonly string[],
      options: Record<string, unknown>,
    ) => {
      calls.push({ command, args, options });
      const child = new EventEmitter() as ChildProcess;
      const stdout = new EventEmitter() as NodeJS.ReadableStream & { setEncoding: () => void };
      stdout.setEncoding = () => undefined;
      Object.assign(child, { stdout });
      setImmediate(() => {
        stdout.emit('data', '4242\n');
        child.emit('close', 0);
      });
      return child;
    }) as unknown as typeof spawn;
    const launch = launchFor(['--no-llm', 'compare espresso grinders']);
    const spawned = await spawnDetachedWorker({
      launch,
      launchDir: join(dir, 'launch'),
      env: { PATH: process.env.PATH },
      nodePath: '/node',
      workerPath: '/worker.js',
      trampolinePath: '/trampoline.js',
      spawn: fakeSpawn,
      identify: (pid) => Promise.resolve({ pid, startToken: 'test' }),
    });
    expect(spawned).toMatchObject({ pid: 4242, identity: { pid: 4242, startToken: 'test' } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      '/trampoline.js',
      '/node',
      '/worker.js',
      '--launch',
      spawned.launchPath,
    ]);
    expect(calls[0]?.options).toMatchObject({
      cwd: dir,
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    expect(JSON.parse(await readFile(spawned.launchPath, 'utf8'))).toEqual(launch);
  });

  it('never overwrites an existing launch file (EEXIST)', async () => {
    const launch = launchFor(['x']);
    const launchDir = join(dir, 'launch');
    const first = spawnDetachedWorker({
      launch,
      launchDir,
      env: {},
      spawn: (() => {
        throw new Error('spawned');
      }) as unknown as typeof spawn,
    });
    await expect(first).rejects.toThrow('spawned');
    await expect(spawnDetachedWorker({ launch, launchDir, env: {} })).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });
});

describe.skipIf(!BUILT)('@no-llm spawnDetachedWorker with real processes', () => {
  it('keeps goal text and option values out of the worker command line', async () => {
    const sleeper = join(dir, 'sleeper.mjs');
    await writeFile(sleeper, 'setTimeout(() => {}, 15000);\n');
    const goal = 'compare-espresso-grinders-under-200-canary';
    const spawned = await spawnDetachedWorker({
      launch: launchFor(['--no-llm', '--length', 'short', goal]),
      launchDir: join(dir, 'launch'),
      env: process.env,
      workerPath: sleeper,
      trampolinePath: TRAMPOLINE,
    });
    pids.push(spawned.pid);
    const commandLine = await commandLineOf(spawned.pid);
    expect(commandLine).toContain('--launch');
    expect(commandLine).toContain(spawned.launchPath);
    expect(commandLine).not.toContain(goal);
    expect(commandLine).not.toContain('short');
    expect(spawned.identity.pid).toBe(spawned.pid);
  }, 30_000);

  /** A parent that spawns a real `prefs set` worker, then exits or stays. */
  async function parentScript(stay: boolean): Promise<string> {
    const script = join(dir, stay ? 'parent-stays.mjs' : 'parent-exits.mjs');
    const spawnModule = pathToFileURL(join(DIST, 'worker', 'spawn.js')).href;
    await writeFile(
      script,
      [
        `import { spawnDetachedWorker } from ${JSON.stringify(spawnModule)};`,
        `const launch = JSON.parse(process.argv[2]);`,
        `const spawned = await spawnDetachedWorker({ launch, launchDir: process.argv[3], env: process.env });`,
        `process.stdout.write('spawned ' + spawned.pid + '\\n');`,
        stay ? `setInterval(() => {}, 1000);` : `process.exit(0);`,
      ].join('\n'),
    );
    return script;
  }

  function workerEnv(home: string): NodeJS.ProcessEnv {
    return { ...process.env, YANTRA_HOME: home, [WORKER_LAUNCH_DIR_ENV]: join(dir, 'launch') };
  }

  async function expectPrefsSet(launch: WorkerLaunch, home: string): Promise<void> {
    await waitFor(() => existsSync(launch.result_path), 90_000);
    const result = WorkerResult.parse(JSON.parse(readFileSync(launch.result_path, 'utf8')));
    expect(result).toMatchObject({
      invocation_id: launch.invocation.invocation_id,
      outcome: { type: 'result', exit_code: 0, text: 'Set defaults.length.\n' },
    });
    // Preferences live in the sandboxed index, which the worker created.
    expect(existsSync(join(home, 'data', 'index.db'))).toBe(true);
  }

  it('completes a mutate command after its parent exits at once', async () => {
    const home = join(dir, 'home');
    const launch = launchFor(['set', 'defaults.length', 'short'], ['prefs']);
    const parent = spawn(
      process.execPath,
      [await parentScript(false), JSON.stringify(launch), join(dir, 'launch')],
      { env: workerEnv(home), stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    parent.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await new Promise((r) => parent.once('close', r));
    const pid = Number(/spawned (\d+)/u.exec(out)?.[1]);
    expect(pid).toBeGreaterThan(0);
    pids.push(pid);
    await expectPrefsSet(launch, home);
  }, 120_000);

  it('survives a process-tree (Windows) or process-group (POSIX) kill of a live parent', async () => {
    const home = join(dir, 'home-tree');
    const launch = launchFor(['set', 'defaults.length', 'short'], ['prefs']);
    const parent = spawn(
      process.execPath,
      [await parentScript(true), JSON.stringify(launch), join(dir, 'launch')],
      {
        env: workerEnv(home),
        stdio: ['ignore', 'pipe', 'inherit'],
        // POSIX: its own group, so the group kill below reaches the parent tree only.
        detached: process.platform !== 'win32',
      },
    );
    let out = '';
    parent.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()));
    await waitFor(() => /spawned \d+/u.test(out), 60_000);
    const workerPid = Number(/spawned (\d+)/u.exec(out)?.[1]);
    pids.push(workerPid);
    if (process.platform === 'win32') {
      await run('taskkill', ['/T', '/F', '/PID', String(parent.pid)]).catch(() => undefined);
    } else {
      process.kill(-(parent.pid ?? 0), 'SIGKILL');
    }
    await waitFor(() => parent.exitCode !== null || parent.signalCode !== null, 10_000);
    await expectPrefsSet(launch, home);
    expect(processExists(parent.pid ?? 0)).toBe(false);
  }, 120_000);
});
