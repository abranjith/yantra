/**
 * @no-llm Run-local session placement tests (FEAT-022 TASK-005, plan §7).
 *
 * These run against the REAL pinned-SDK `SessionManager` (no stubs) — they
 * are the spike acceptance that direct creation under `<runDir>/agent/`
 * works, including on Windows (this file is mandatory on the Windows CI leg).
 */

import { readdir, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRunLocalSession } from '../../../src/adapters/pi/session-file.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

/** Minimal assistant message that triggers the SDK's lazy JSONL flush. */
function assistantMessage() {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
    api: 'openai-completions',
    provider: 'testprov',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 0,
  };
}

const normalize = (path: string): string => path.replace(/\\/g, '/');

async function listJsonl(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name.endsWith('.jsonl'));
}

describe('@no-llm run-local session placement', () => {
  it('creates the session JSONL directly under <runDir>/agent/ — exactly one after finalize', async () => {
    const runDir = await makeTempDir('yantra-sess-run-');
    const cwd = await makeTempDir('yantra-sess-cwd-');

    const runLocal = await createRunLocalSession({ runDir, cwd });
    expect(normalize(runLocal.sessionDir)).toBe(normalize(join(runDir, 'agent')));
    expect(runLocal.sessionManager.usesDefaultSessionDir()).toBe(false);

    // Simulate a completed exchange (the SDK flushes on the first assistant message).
    runLocal.sessionManager.appendMessage({ role: 'user', content: 'hi', timestamp: 0 });
    runLocal.sessionManager.appendMessage(assistantMessage());
    await runLocal.finalize();

    const files = await listJsonl(runLocal.sessionDir);
    expect(files).toHaveLength(1);
    expect(normalize(runLocal.logPath())).toBe(
      normalize(join(runLocal.sessionDir, files[0] ?? '')),
    );

    // The header records our cwd and the file is line-delimited JSON.
    const lines = (await readFile(runLocal.logPath(), 'utf8')).trim().split('\n');
    const header = JSON.parse(lines[0] ?? '{}') as { type?: string; cwd?: string };
    expect(header.type).toBe('session');
    expect(normalize(header.cwd ?? '')).toBe(normalize(cwd));
  });

  it('the failure path (aborted before any assistant message) still leaves a readable session file', async () => {
    const runDir = await makeTempDir('yantra-sess-fail-');
    const cwd = await makeTempDir('yantra-sess-fail-cwd-');

    const runLocal = await createRunLocalSession({ runDir, cwd });
    // Only a user message — the SDK's lazy flush never fires on its own.
    runLocal.sessionManager.appendMessage({ role: 'user', content: 'goal', timestamp: 0 });
    await runLocal.finalize();

    const files = await listJsonl(runLocal.sessionDir);
    expect(files).toHaveLength(1);
    const firstLine = (await readFile(runLocal.logPath(), 'utf8')).trim().split('\n')[0];
    expect((JSON.parse(firstLine ?? '{}') as { type?: string }).type).toBe('session');
  });

  it('handles Windows-style paths: absolute, backslash-safe, no "~" expansion assumptions', async () => {
    const base = await makeTempDir('yantra-sess-win-');
    // Spaces and mixed separators exercise the SDK's path normalization.
    const runDir = join(base, 'runs', 'run with spaces');
    const cwd = base;

    const runLocal = await createRunLocalSession({ runDir, cwd });
    const logPath = runLocal.logPath();

    expect(isAbsolute(logPath)).toBe(true);
    expect(logPath).not.toContain('~');
    expect(normalize(logPath).startsWith(normalize(join(runDir, 'agent')))).toBe(true);

    runLocal.sessionManager.appendMessage(assistantMessage());
    await runLocal.finalize();
    expect(await listJsonl(runLocal.sessionDir)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')(
    'applies restrictive permissions to the finalized session file (POSIX)',
    async () => {
      const runDir = await makeTempDir('yantra-sess-perm-');
      const cwd = await makeTempDir('yantra-sess-perm-cwd-');

      const runLocal = await createRunLocalSession({ runDir, cwd });
      runLocal.sessionManager.appendMessage(assistantMessage());
      await runLocal.finalize();

      const fileMode = (await stat(runLocal.logPath())).mode & 0o777;
      expect(fileMode).toBe(0o600);
      const dirMode = (await stat(runLocal.sessionDir)).mode & 0o777;
      expect(dirMode).toBe(0o700);
    },
  );
});
