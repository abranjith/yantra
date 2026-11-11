// @no-llm
/**
 * Worker launch validation, class gating and the start gate (FEAT-064 TASK-012).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerResult, generateUlid, type CommandResultMessage } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runWorker } from '../../src/worker/entry.js';
import { WORKER_LAUNCH_DIR_ENV } from '../../src/worker/launch.js';

let launchDir: string;
let env: NodeJS.ProcessEnv;
const noChdir = (): void => undefined;

beforeEach(async () => {
  launchDir = await mkdtemp(join(tmpdir(), 'yantra-worker-launch-'));
  env = { ...process.env, [WORKER_LAUNCH_DIR_ENV]: launchDir };
});

afterEach(async () => {
  await rm(launchDir, { recursive: true, force: true });
});

async function writeLaunch(
  path: readonly string[],
  argv: readonly string[],
  overrides: Record<string, unknown> = {},
): Promise<{ launchPath: string; resultPath: string; id: string }> {
  const id = generateUlid();
  const launchPath = join(launchDir, `${id}.launch.json`);
  const resultPath = join(launchDir, `${id}.result.json`);
  await writeFile(
    launchPath,
    JSON.stringify({
      schema_version: 1,
      invocation: { invocation_id: id, path, argv, cwd: launchDir },
      result_path: resultPath,
      ...overrides,
    }),
  );
  return { launchPath, resultPath, id };
}

function result(path: string): WorkerResult {
  return WorkerResult.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const ok: CommandResultMessage = { type: 'result', exit_code: 0, envelope: null, text: 'done' };

describe('@no-llm runWorker argv', () => {
  it.each([[[]], [['--launch']], [['--launch', '/a', '--x']], [['--other', '/a']]])(
    'exits 1 for %j',
    async (argv) => {
      expect(await runWorker(argv, { env, chdir: noChdir })).toBe(1);
    },
  );
});

describe('@no-llm runWorker launch validation', () => {
  it('exits 1 with an error result for a malformed launch file', async () => {
    const id = generateUlid();
    const launchPath = join(launchDir, `${id}.launch.json`);
    await writeFile(launchPath, '{ not json');
    expect(await runWorker(['--launch', launchPath], { env, chdir: noChdir })).toBe(1);
    expect(result(join(launchDir, `${id}.result.json`))).toMatchObject({
      invocation_id: id,
      outcome: { type: 'error', exit_code: 1, code: 'WORKER_LAUNCH_INVALID' },
    });
  });

  it('exits 1 with an error result for a launch that fails the schema', async () => {
    const { launchPath, resultPath } = await writeLaunch(['prefs'], ['list'], {
      env: { SECRET: 'x' },
    });
    expect(await runWorker(['--launch', launchPath], { env, chdir: noChdir })).toBe(1);
    expect(result(resultPath).outcome).toMatchObject({ code: 'WORKER_LAUNCH_INVALID' });
  });

  it('refuses a launch file outside the launch directory and writes nothing there', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'yantra-worker-elsewhere-'));
    try {
      const launchPath = join(elsewhere, `${generateUlid()}.launch.json`);
      await writeFile(launchPath, '{}');
      expect(await runWorker(['--launch', launchPath], { env, chdir: noChdir })).toBe(1);
      expect(readdirSync(elsewhere)).toHaveLength(1);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('@no-llm runWorker class gate', () => {
  it.each([
    ['secret set (in-process-secure)', ['secret', 'set'], ['API_KEY']],
    ['config data-dir (exemption)', ['config', 'data-dir'], []],
    ['list (read)', ['list'], ['runs']],
  ])('refuses %s with WORKER_CLASS_REFUSED', async (_label, path, argv) => {
    const run = vi.fn();
    const { launchPath, resultPath } = await writeLaunch(path, argv);
    expect(await runWorker(['--launch', launchPath], { env, chdir: noChdir, run })).toBe(1);
    expect(result(resultPath).outcome).toMatchObject({
      type: 'error',
      exit_code: 1,
      code: 'WORKER_CLASS_REFUSED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a mutate command through the worker adapter in the invocation cwd', async () => {
    const chdir = vi.fn();
    const run = vi.fn(() => Promise.resolve(ok));
    const { launchPath, resultPath, id } = await writeLaunch(
      ['prefs'],
      ['set', 'defaults.length', 'short'],
      { run_id: 'preallocated-run' },
    );
    expect(await runWorker(['--launch', launchPath], { env, run, chdir })).toBe(0);
    expect(chdir).toHaveBeenCalledWith(launchDir);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ invocation_id: id, path: ['prefs'] }),
      expect.anything(),
      env,
      {},
    );
    expect(result(resultPath)).toEqual({
      schema_version: 1,
      invocation_id: id,
      run_id: 'preallocated-run',
      outcome: ok,
    });
  });
});

describe('@no-llm runWorker start gate and failures', () => {
  it('exits 0 with no side effects when the start gate refuses', async () => {
    const run = vi.fn();
    const { launchPath, resultPath } = await writeLaunch(['research'], ['--no-llm', 'x']);
    expect(
      await runWorker(['--launch', launchPath], {
        env,
        chdir: noChdir,
        run,
        gate: () => Promise.resolve(false),
      }),
    ).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(resultPath)).toBe(false);
  });

  it('turns an uncaught failure into an error result with exit 2', async () => {
    const { launchPath, resultPath } = await writeLaunch(['research'], ['--no-llm', 'x']);
    const code = await runWorker(['--launch', launchPath], {
      env,
      chdir: () => undefined,
      run: () => Promise.reject(new Error('handler blew up')),
    });
    expect(code).toBe(2);
    expect(result(resultPath).outcome).toMatchObject({
      type: 'error',
      exit_code: 2,
      code: 'WORKER_FAILED',
    });
  });
});
