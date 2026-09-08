/**
 * @no-llm
 *
 * Smoke coverage for the CLI surface added in FEAT-012. Exercises the
 * read-only commands against an isolated `YANTRA_HOME` so we don't touch the
 * user's real `~/.yantra/`. Yantra resolves one storage root on every
 * platform, so `YANTRA_HOME` is the only variable that isolates these runs —
 * XDG and `%APPDATA%` are ignored by design.
 *
 * Bypasses `process.exit` by trapping it during each command invocation.
 * The CLI handlers call `process.exit(<code>)` directly today; future work
 * (TASK-001's CommandOutcome plumbing) will let commands return outcomes
 * for cleaner testing.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { run } from '@yantra/cli';
import { resetPathCache } from '@yantra/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serveFixtureSite } from './fixtures/serve.js';

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
  let savedYantraHome: string | undefined;

  beforeEach(async () => {
    tmpHome = await mkdtemp(join(tmpdir(), 'yantra-cli-cmd-'));
    savedYantraHome = process.env.YANTRA_HOME;
    process.env.YANTRA_HOME = tmpHome;
    // dataDir()/cacheDir() memoize their first resolution per process, so a
    // new home per test is only honored after the memo is dropped.
    resetPathCache();
  });

  afterEach(async () => {
    if (savedYantraHome === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = savedYantraHome;
    resetPathCache();
    await rm(tmpHome, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: 50,
    });
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
    expect(parsed.schemaVersion).toBe('0.2');
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

  it('loads and replays a pre-agentic workflow while preserving audit access to an old run', async () => {
    const fixture = await serveFixtureSite();
    try {
      const dataRoot = join(tmpHome, 'data');
      const workflowsDir = join(dataRoot, 'workflows');
      const runsDir = join(dataRoot, 'runs');
      const oldRunId = '20260516T120000Z-legacy-workflow-a7b3';
      const oldRunDir = join(runsDir, oldRunId);
      await mkdir(workflowsDir, { recursive: true });
      await mkdir(oldRunDir, { recursive: true });

      // This is the version-1 user-authored shape shipped before the agentic
      // runtime. It is written directly instead of passing through the current
      // emitter so the test remains a genuine compatibility fixture.
      await writeFile(
        join(workflowsDir, 'legacy-workflow.yaml'),
        [
          'version: 1',
          'name: legacy-workflow',
          'description: Pre-agentic compatibility fixture',
          'security_class: public',
          'steps:',
          `  - navigate: ${fixture.baseUrl}/index.html`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(oldRunDir, 'manifest.json'),
        JSON.stringify({
          runId: oldRunId,
          taskId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          workflowName: 'legacy-workflow',
          workflowVersion: 1,
          params: {},
          startedAt: '2026-05-16T12:00:00.000Z',
          endedAt: '2026-05-16T12:00:01.000Z',
          status: 'completed',
          durationMs: 1000,
          profileKind: 'ephemeral',
          cookieProfilePath: null,
          outputBindingNames: [],
        }),
        'utf8',
      );
      await writeFile(
        join(oldRunDir, 'events.jsonl'),
        `${JSON.stringify({ kind: 'step_started', step_id: 's1', scope: 'public' })}\n`,
        'utf8',
      );

      const listed = await invoke(['list', 'workflows', '--json']);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout).toContain('legacy-workflow');

      const replayed = await invoke(['run', 'legacy-workflow', '--json']);
      expect(replayed.exitCode).toBe(0);
      expect(JSON.parse(replayed.stdout)).toMatchObject({ kind: 'success' });

      const audited = await invoke(['audit', oldRunId, '--json']);
      expect(audited.exitCode).toBe(0);
      expect(JSON.parse(audited.stdout)).toMatchObject({
        kind: 'audit',
        runId: oldRunId,
        workflowName: 'legacy-workflow',
        status: 'completed',
        stepCount: 1,
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);

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
