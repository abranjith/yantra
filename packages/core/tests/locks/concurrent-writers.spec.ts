import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';

import { defaultConfig } from '../../src/config/load.js';
import { redactConfigRefs } from '../../src/config/refs.js';
import { defaultProfile } from '../../src/profile/profile-file.js';

const yamlModule = pathToFileURL(createRequire(import.meta.url).resolve('yaml')).href;
const configModule = new URL('../../dist/config/write.js', import.meta.url).href;
const profileModule = new URL('../../dist/profile/profile-file.js', import.meta.url).href;

/** Real children synchronize before writing; no promise-only concurrency double. */
const writerSource = `
  import { readFile, writeFile, rename } from 'node:fs/promises';
  import { join } from 'node:path';
  import { parse, stringify } from ${JSON.stringify(yamlModule)};
  import { mutateConfig } from ${JSON.stringify(configModule)};
  import { mutateProfile } from ${JSON.stringify(profileModule)};
  const [home, kind, key, encoded, mode] = process.argv.slice(2);
  const path = join(home, kind === 'config' ? 'config.yaml' : 'profile.yaml');
  const patch = (record) => {
    const next = structuredClone(record);
    const tokens = key.split('.');
    let cursor = next;
    for (const token of tokens.slice(0, -1)) cursor = cursor[token];
    cursor[tokens.at(-1)] = JSON.parse(encoded);
    return next;
  };
  // The legacy double deliberately takes its snapshot before every child says ready.
  const snapshot = mode === 'legacy' ? patch(parse(await readFile(path, 'utf8'))) : null;
  process.once('message', async () => {
    try {
      if (mode === 'legacy') {
        const temporary = path + '.tmp';
        await writeFile(temporary, stringify(snapshot));
        await rename(temporary, path);
      } else {
        const mutate = kind === 'config' ? mutateConfig : mutateProfile;
        await mutate(patch, path, { owner: {
          pid: process.pid, command: 'fixture writer', surface: 'worker',
          started_at: new Date().toISOString(),
        } });
      }
    } catch (error) {
      process.stderr.write(String(error.code ?? error.message));
      process.exitCode = 1;
    } finally { process.disconnect(); }
  });
  process.send({ ready: true });
`;

function valueAt(record: unknown, key: string): unknown {
  let current = record;
  for (const token of key.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

describe('@no-llm real process config/profile writer coordination', () => {
  let root: string;
  let script: string;
  const children: ChildProcess[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'yantra-writer-processes-'));
    script = join(root, 'writer.mjs');
    await writeFile(script, writerSource);
  });
  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => {
          child.once('close', () => resolve());
        });
        child.kill();
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  async function race(kind: 'config' | 'profile', iteration: number, mode: 'locked' | 'legacy') {
    const home = join(root, `${kind}-${iteration}-${mode}`);
    await mkdir(home);
    const filename = `${kind}.yaml`;
    await writeFile(
      join(home, filename),
      kind === 'config'
        ? stringify(redactConfigRefs(defaultConfig()))
        : stringify(defaultProfile()),
    );
    const fields: readonly (readonly [string, string | number])[] =
      kind === 'config'
        ? [
            ['retention.runs_days', iteration + 31],
            ['retention.corrupt_index_keep', iteration + 4],
            ['ethics.rate_limit.default.tokens_per_second', iteration + 2],
            ['ethics.rate_limit.default.burst', iteration + 3],
          ]
        : [
            ['locale.city', `City-${iteration}`],
            ['locale.region', `Region-${iteration}`],
            ['agent.model', `Model-${iteration}`],
            ['defaults.detail', 'full'],
          ];
    const workers = fields.map(([key, value]) => {
      const child = fork(script, [home, kind, key, JSON.stringify(value), mode], {
        silent: true,
        execArgv: [],
        env: { ...process.env, YANTRA_HOME: home },
      });
      children.push(child);
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`writer exited before ready (${code}): ${stderr}`)),
        );
      });
      const done = new Promise<{ code: number | null; stderr: string }>((resolve) => {
        child.once('close', (code) => resolve({ code, stderr }));
      });
      return { child, ready, done };
    });
    await Promise.all(workers.map((worker) => worker.ready));
    for (const worker of workers) worker.child.send('write');
    const outcomes = await Promise.all(workers.map((worker) => worker.done));
    const document: unknown = parse(await readFile(join(home, filename), 'utf8'));
    return {
      outcomes,
      retained: fields.filter(([key, value]) => valueAt(document, key) === value).length,
    };
  }

  it('retains every config and profile change across 20 four-writer iterations', async () => {
    for (let iteration = 0; iteration < 20; iteration++) {
      for (const kind of ['config', 'profile'] as const) {
        const result = await race(kind, iteration, 'locked');
        expect({ kind, iteration, outcomes: result.outcomes }).toEqual({
          kind,
          iteration,
          outcomes: Array.from({ length: 4 }, () => ({ code: 0, stderr: '' })),
        });
        expect({ kind, iteration, retained: result.retained }).toEqual({
          kind,
          iteration,
          retained: 4,
        });
      }
    }
  }, 120_000);

  it('reproduces the old shared-temp lost-update/rename race', async () => {
    for (const kind of ['config', 'profile'] as const) {
      const result = await race(kind, 0, 'legacy');
      expect(result.outcomes.some((outcome) => outcome.code !== 0) || result.retained < 4).toBe(
        true,
      );
      expect(result.retained).toBeLessThan(4);
    }
  }, 30_000);
});
