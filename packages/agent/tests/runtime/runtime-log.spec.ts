/**
 * The run-scoped operator diagnostic log.
 *
 * Two guarantees matter here and nowhere else: every line a component wrote
 * before teardown is on disk and parseable, and the destination is closed
 * exactly once with no handle left open. A run that loses its last lines has
 * lost precisely the ones that explain why it ended.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRuntimeLinesAreSafe, parseRuntimeLog } from '@yantra/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';

import { RUNTIME_LOG_FILENAME, RunRuntimeLog } from '../../src/runtime/runtime-log.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function runDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'yantra-runtime-log-'));
  dirs.push(dir);
  return dir;
}

describe('@no-llm RunRuntimeLog', () => {
  it('writes every record as parseable JSONL bound to the run id', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-abc', runDir: dir });

    log.logger.info({ event: 'browser_ready', schema_version: 1 }, 'launching Chrome');
    log.logger.warn({ event: 'browser_startup_failed', phase: 'launch' }, 'refused');
    log.logger.error({ event: 'tool_unexpected_failure', tool: 'web_fetch' }, 'unexpected');
    await log.close();

    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.run_id === 'run-abc')).toBe(true);
    expect(lines.map((line) => line.event)).toEqual([
      'browser_ready',
      'browser_startup_failed',
      'tool_unexpected_failure',
    ]);
    assertRuntimeLinesAreSafe(lines);
  });

  it('writes to <runDir>/runtime.jsonl and nowhere else', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-path', runDir: dir });

    log.logger.info({ event: 'browser_ready' });
    await log.close();

    expect(log.path).toBe(join(dir, RUNTIME_LOG_FILENAME));
    await expect(stat(log.path)).resolves.toBeDefined();
  });

  it('closes exactly once even when close is called repeatedly and concurrently', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-idempotent', runDir: dir });
    log.logger.info({ event: 'browser_ready' });

    await Promise.all([log.close(), log.close()]);
    await log.close();

    expect(log.isClosed()).toBe(true);
    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines).toHaveLength(1);
  });

  it('drops writes after close instead of reopening the destination', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-after-close', runDir: dir });
    log.logger.info({ event: 'browser_ready' });
    await log.close();
    const after = await readFile(log.path, 'utf8');

    // Documented contract: a component logging after teardown is logging about
    // a run that no longer exists. The line is dropped; nothing is reopened.
    log.logger.info({ event: 'browser_ready', late: true });
    log.logger.error({ event: 'tool_unexpected_failure', late: true });

    expect(await readFile(log.path, 'utf8')).toBe(after);
    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toHaveProperty('late');
  });

  it('flushes buffered records that were written immediately before close', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-flush', runDir: dir });

    // An asynchronous destination buffers; without the flush in close() these
    // last lines — the teardown evidence — would never reach disk.
    for (let i = 0; i < 200; i += 1) log.logger.info({ event: 'browser_ready', seq: i });
    await log.close();

    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines).toHaveLength(200);
    expect(lines[199]).toMatchObject({ seq: 199 });
  });

  it('accepts a bare string message without losing the run binding', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-string', runDir: dir });

    log.logger.debug('a component logged a plain string');
    log.logger.info('so did another');
    await log.close();

    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines.every((line) => line.run_id === 'run-string')).toBe(true);
  });

  it('is a single destination: two loggers from one log share one file', async () => {
    const dir = await runDir();
    const log = RunRuntimeLog.open({ runId: 'run-single', runDir: dir });

    // Both "components" hold the same logger reference, which is the whole
    // point — a second RunRuntimeLog on the same path would interleave two
    // buffers into one append-only artifact.
    const componentA = log.logger;
    const componentB = log.logger;
    componentA.info({ event: 'browser_ready', from: 'a' });
    componentB.info({ event: 'browser_ready', from: 'b' });
    await log.close();

    const lines = await parseRuntimeLog(await readFile(join(dir, RUNTIME_LOG_FILENAME), 'utf8'));
    expect(lines.map((line) => line.from)).toEqual(['a', 'b']);
  });
});
