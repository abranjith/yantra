/**
 * @no-llm
 *
 * Smoke coverage for the CLI surface added in FEAT-012. Exercises the
 * read-only commands against an isolated XDG data root so we don't touch
 * the user's real `~/.local/share/yantra/`.
 *
 * Bypasses `process.exit` by trapping it during each command invocation.
 * The CLI handlers call `process.exit(<code>)` directly today; future work
 * (TASK-001's CommandOutcome plumbing) will let commands return outcomes
 * for cleaner testing.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface InvocationResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function invoke(argv: readonly string[]): Promise<InvocationResult> {
  let stdoutData = '';
  let stderrData = '';
  let exitCode = 0;

  const outStream = new Writable({
    write(chunk, _enc, cb) {
      stdoutData += String(chunk);
      cb();
    },
  });
  const errStream = new Writable({
    write(chunk, _enc, cb) {
      stderrData += String(chunk);
      cb();
    },
  });

  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/unbound-method -- process.exit is assigned a bound mock immediately below; storing the original reference is the only way to restore it.
  const originalExit = process.exit;

  process.stdout.write = (chunk: unknown): boolean => {
    outStream.write(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    errStream.write(String(chunk));
    return true;
  };

  // Intercept process.exit so tests don't tear down vitest. Only honor the
  // FIRST exit call — generic try/catch blocks in the CLI commands swallow
  // the synthetic exit-error and then call process.exit(1) themselves; we
  // want to preserve the original (successful) exit code.
  let exited = false;

  process.exit = (code?: number) => {
    if (!exited) {
      exitCode = code ?? 0;
      exited = true;
    }
    throw new Error('__cli_exit__');
  };

  try {
    await run(argv).catch((err: unknown) => {
      if (err instanceof Error && err.message === '__cli_exit__') return;
      throw err;
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exit = originalExit;
  }

  return { exitCode, stdout: stdoutData, stderr: stderrData };
}

describe('@no-llm cli commands e2e', () => {
  let tmpHome: string;
  let savedXdg: string | undefined;
  let savedLocalAppData: string | undefined;
  let savedConfigHome: string | undefined;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'yantra-cli-cmd-'));
    savedXdg = process.env.XDG_DATA_HOME;
    savedLocalAppData = process.env.LOCALAPPDATA;
    savedConfigHome = process.env.XDG_CONFIG_HOME;
    savedAppData = process.env.APPDATA;
    process.env.XDG_DATA_HOME = tmpHome;
    process.env.LOCALAPPDATA = tmpHome;
    process.env.XDG_CONFIG_HOME = tmpHome;
    process.env.APPDATA = tmpHome;
  });

  afterEach(async () => {
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedXdg;
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('yantra (no args) prints the protocol banner and exits 0', async () => {
    const result = await invoke([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/yantra \(protocol=.*core=.*agent=.*\)/);
  });

  it('yantra list runs --json emits an empty list on a fresh data root', async () => {
    const result = await invoke(['list', 'runs', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: string;
      kind: string;
      items: unknown[];
    };
    expect(parsed.schemaVersion).toBe('0.1');
    expect(parsed.kind).toBe('list');
    expect(parsed.items).toEqual([]);
  });

  it('yantra list workflows --json emits an empty list on a fresh data root', async () => {
    const result = await invoke(['list', 'workflows', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind: string; items: unknown[] };
    expect(parsed.kind).toBe('list');
    expect(parsed.items).toEqual([]);
  });

  it('yantra audit <missing-run> exits with a non-zero validation error', async () => {
    const result = await invoke(['audit', '20260516T120000Z-not-real-zzzz', '--json']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });

  it('yantra report <missing-run> exits with a non-zero error', async () => {
    const result = await invoke(['report', '20260516T120000Z-not-real-zzzz']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('not found');
  });

  it('yantra init --provider none --json writes a default config', async () => {
    const result = await invoke(['init', '--provider', 'none', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind: string; status: string };
    expect(parsed.kind).toBe('init');
    expect(parsed.status).toBe('written');
  });

  it('yantra init --provider invalid exits 1', async () => {
    const result = await invoke(['init', '--provider', 'bogus', '--json']);
    expect(result.exitCode).toBe(1);
  });
});
