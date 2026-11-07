import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { resetPathCache } from '@yantra/core';
import { vi } from 'vitest';

import { run, type CliRunOptions } from '../../src/index.js';

export interface ScenarioResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly tree: Readonly<Record<string, string>>;
}

/** Remove invocation identities while preserving the actual output and file structure. */
export function normalize(value: string, home: string): string {
  return value
    .replaceAll(JSON.stringify(home).slice(1, -1), '<home>')
    .replaceAll(home, '<home>')
    .replaceAll(home.replaceAll('\\', '/'), '<home>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<time>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/("(?:pid|duration_ms|elapsed_ms)"\s*:\s*)\d+/g, '$1<counter>');
}

/** Snapshot only durable application files, in a stable traversal order. */
export async function snapshotTree(home: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (!/\.(db|db-wal|db-shm)$/.test(entry.name)) {
        result[normalize(relative(home, path).replaceAll('\\', '/'), home)] = normalize(
          await readFile(path, 'utf8'),
          home,
        );
      }
    }
  }
  await visit(home);
  return result;
}

class InterceptedExit extends Error {
  public constructor(public readonly code: number) {
    super(`intercepted exit ${code}`);
  }
}

/** The pre-migration terminal boundary; process spies never escape this call. */
export async function runTerminalScenario(request: {
  readonly argv: readonly string[];
  readonly home: string;
  readonly tty?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly runtime?: CliRunOptions;
}): Promise<ScenarioResult> {
  const previousEnv = process.env;
  const previousExitCode = process.exitCode;
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  let stdout = '';
  let stderr = '';
  process.env = { ...previousEnv, ...request.env, YANTRA_HOME: request.home };
  resetPathCache();
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: request.tty ?? false,
  });
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new InterceptedExit(Number(code ?? 0));
  });
  let exitCode: number;
  try {
    exitCode = await run(request.argv, request.runtime);
    // Old run() may translate a thrown exit into its generic failure path.
    if (exit.mock.calls.length) exitCode = Number(exit.mock.calls.at(-1)?.[0] ?? 0);
    else if (process.exitCode !== previousExitCode) exitCode = Number(process.exitCode ?? 0);
  } catch (error) {
    if (!(error instanceof InterceptedExit)) throw error;
    exitCode = error.code;
  } finally {
    out.mockRestore();
    err.mockRestore();
    exit.mockRestore();
    if (descriptor) Object.defineProperty(process.stdin, 'isTTY', descriptor);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    process.env = previousEnv;
    process.exitCode = previousExitCode;
    resetPathCache();
  }
  return {
    stdout: normalize(stdout, request.home),
    stderr: normalize(stderr, request.home),
    exitCode,
    tree: await snapshotTree(request.home),
  };
}

/**
 * Capture actual exits in a child as well: legacy catch blocks can catch a
 * throwing process.exit spy and print an extra error. Only a real exit proves
 * the original observable behavior of those paths.
 */
export async function runTerminalProcessScenario(request: {
  readonly argv: readonly string[];
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
}): Promise<ScenarioResult> {
  const entry = new URL('../../dist/index.js', import.meta.url).href;
  const brief = new URL('../../../../packages/test-helpers/dist/brief.js', import.meta.url).href;
  const script = `
    import { registerHooks } from 'node:module';
    const keytar = 'data:text/javascript,' + encodeURIComponent('export default { getPassword: async () => null, setPassword: async () => {}, deletePassword: async () => false, findCredentials: async () => [] };');
    registerHooks({ resolve(specifier, context, next) { return specifier === 'keytar' ? { url: keytar, shortCircuit: true } : next(specifier, context); } });
    const { run } = await import(${JSON.stringify(entry)});
    const { canonicalBrief } = await import(${JSON.stringify(brief)});
    const result = { brief: canonicalBrief, artifacts: null, hops: [], terminationReason: 'max_hops' };
    const runtime = { env: {}, isTty: false, recordHistory: async () => {} };
    process.exitCode = await run(JSON.parse(process.argv[1]), {
      askRuntime: { ...runtime, createPipeline: async () => ({ run: async () => result }) },
      researchRuntime: { ...runtime, createLoop: async () => ({ run: async () => result }) },
      doRuntime: runtime,
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', script, JSON.stringify(request.argv)],
    {
      env: { ...process.env, ...request.env, YANTRA_HOME: request.home, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(request.stdin ?? '');
  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('characterization child exceeded 20s'));
    }, 20_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code ?? 2);
    });
  });
  return {
    stdout: normalize(stdout, request.home),
    stderr: normalize(stderr, request.home),
    exitCode,
    tree: await snapshotTree(request.home),
  };
}
