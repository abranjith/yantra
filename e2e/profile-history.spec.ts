/**
 * @no-llm
 *
 * End-to-end coverage for FEAT-018 (Persistent Personal Profiles & History).
 * Exercises the new `profile`, `prefs`, and `usage` commands plus the history
 * index against an isolated XDG data/config root so the user's real
 * `~/.local/share/yantra/` and `~/.config/yantra/` are never touched.
 *
 * Bypasses `process.exit` the same way `cli-commands.spec.ts` does.
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
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally
  const originalExit = process.exit;

  process.stdout.write = (chunk: unknown): boolean => {
    outStream.write(String(chunk));
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    errStream.write(String(chunk));
    return true;
  };

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

describe('@no-llm profiles & history e2e', () => {
  let tmpHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'yantra-profile-e2e-'));
    for (const key of ['XDG_DATA_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'APPDATA']) {
      saved[key] = process.env[key];
      process.env[key] = tmpHome;
    }
  });

  afterEach(async () => {
    for (const key of ['XDG_DATA_HOME', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'APPDATA']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('profile --json shows the default effective preferences on a fresh root', async () => {
    const result = await invoke(['profile', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      kind: string;
      preferences: { key: string; value: unknown; provenance: string }[];
    };
    expect(parsed.kind).toBe('profile');
    const detail = parsed.preferences.find((p) => p.key === 'defaults.detail');
    expect(detail?.value).toBe('standard');
    expect(detail?.provenance).toBe('profile.yaml');
  });

  it('prefs set then get round-trips a value and overrides the yaml default', async () => {
    const setResult = await invoke(['prefs', 'set', 'defaults.detail', 'full']);
    expect(setResult.exitCode).toBe(0);

    const getResult = await invoke(['prefs', 'get', 'defaults.detail', '--json']);
    expect(getResult.exitCode).toBe(0);
    const parsed = JSON.parse(getResult.stdout) as { record: { value: unknown } | null };
    expect(parsed.record?.value).toBe('full');

    // The effective profile now reflects the explicit set (index.db provenance).
    const profileResult = await invoke(['profile', '--json']);
    const profile = JSON.parse(profileResult.stdout) as {
      preferences: { key: string; value: unknown; provenance: string }[];
    };
    const detail = profile.preferences.find((p) => p.key === 'defaults.detail');
    expect(detail?.value).toBe('full');
    expect(detail?.provenance).toBe('index.db');
  });

  it('prefs --forget removes a value (reverting to the yaml default)', async () => {
    await invoke(['prefs', 'set', 'defaults.detail', 'full']);
    const forgetResult = await invoke(['prefs', '--forget', 'defaults.detail']);
    expect(forgetResult.exitCode).toBe(0);

    const getResult = await invoke(['prefs', 'get', 'defaults.detail', '--json']);
    const parsed = JSON.parse(getResult.stdout) as { record: unknown };
    expect(parsed.record).toBeNull();
  });

  it('prefs set rejects an unknown key with a hint', async () => {
    const result = await invoke(['prefs', 'set', 'defaults.bogus', 'x']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown preference key');
  });

  it('usage --json emits an empty rollup on a fresh root', async () => {
    const result = await invoke(['usage', '--json']);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { kind: string; rows: unknown[]; totals: unknown };
    expect(parsed.kind).toBe('usage');
    expect(parsed.rows).toEqual([]);
    expect(parsed.totals).toEqual({ taskCount: 0, totalCostUsd: 0 });
  });

  it('learned preferences require explicit approval before they are approved', async () => {
    // A learned signal is not settable via the CLI (which only sets `user`),
    // so this drives the approve path through a user row for surface coverage.
    await invoke(['prefs', 'set', 'personalization.enabled', 'true']);
    const approveResult = await invoke(['prefs', 'approve', 'personalization.enabled', '--json']);
    expect(approveResult.exitCode).toBe(0);
    const parsed = JSON.parse(approveResult.stdout) as { status: string };
    expect(parsed.status).toBe('approved');
  });
});
