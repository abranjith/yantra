// @no-llm
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_RUN_EVENT_LINE_BYTES } from '@yantra/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  RUN_EVENTS_FILENAME,
  RUN_EVENTS_SYNC_EVERY,
  RUN_EVENTS_SYNC_INTERVAL_MS,
  RunEventLog,
  RunEventLogError,
} from '../../src/run-events/log.js';

import {
  AT,
  ManualScheduler,
  assistantText,
  cleanupRunDirs,
  consentRequest,
  interventionRaised,
  makeRunDir,
  readAll,
  readSeqs,
  runOutcome,
  taskStarted,
} from './support.js';

afterEach(cleanupRunDirs);

function line(seq: number, event: unknown = taskStarted()): string {
  return `${JSON.stringify({ schema_version: '1', seq, run_id: 'run-1', event })}\n`;
}

function openLog(runDir: string, extra: Partial<Parameters<typeof RunEventLog.open>[0]> = {}) {
  return RunEventLog.open({ runDir, runId: 'run-1', scheduler: new ManualScheduler(), ...extra });
}

describe('@no-llm RunEventLog sequence', () => {
  it('starts a fresh file at seq 1 and stays gap-free over 1,000 appends', async () => {
    const runDir = await makeRunDir();
    const log = openLog(runDir, { sync: () => undefined });

    const assigned = Array.from({ length: 1000 }, (_, i) => log.append(assistantText(`t${i}`)));
    log.close();

    expect(assigned).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(await readSeqs(join(runDir, RUN_EVENTS_FILENAME))).toEqual(assigned);
  });

  it('writes the envelope with the run id and the schema version', async () => {
    const runDir = await makeRunDir();
    const log = openLog(runDir);
    log.append(taskStarted());
    log.close();

    expect(JSON.parse(readFileSync(log.path, 'utf8'))).toEqual({
      schema_version: '1',
      seq: 1,
      run_id: 'run-1',
      event: { task_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', at: AT, kind: 'task_started' },
    });
  });

  it('continues from the last valid seq of an existing file', async () => {
    const runDir = await makeRunDir();
    writeFileSync(join(runDir, RUN_EVENTS_FILENAME), line(1) + line(2) + line(3));
    const log = openLog(runDir);

    expect(log.nextSequence).toBe(4);
    expect(log.append(taskStarted())).toBe(4);
    log.close();
  });

  it('counts a newer writer’s unknown-kind line when continuing', async () => {
    const runDir = await makeRunDir();
    writeFileSync(
      join(runDir, RUN_EVENTS_FILENAME),
      line(1) + line(2, { kind: 'attendance_changed', at: AT }),
    );

    expect(openLog(runDir).nextSequence).toBe(3);
  });

  it('strips unknown keys from the stored record', async () => {
    const runDir = await makeRunDir();
    const log = openLog(runDir);
    log.append({ ...taskStarted(), secret: 'never-stored' } as never);
    log.close();

    expect(readFileSync(log.path, 'utf8')).not.toContain('never-stored');
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-only', async () => {
    const runDir = await makeRunDir();
    openLog(runDir).close();

    expect(statSync(join(runDir, RUN_EVENTS_FILENAME)).mode & 0o777).toBe(0o600);
  });
});

describe('@no-llm RunEventLog tail recovery', () => {
  it('truncates a partial final line on open and continues at lastSeq + 1', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const valid = line(1) + line(2);
    writeFileSync(path, `${valid}{"schema_version":"1","seq":3,"run_`);

    // A reader ignores the partial line without anyone reopening the file.
    expect(await readSeqs(path)).toEqual([1, 2]);

    const log = openLog(runDir);
    expect(statSync(path).size).toBe(Buffer.byteLength(valid));
    expect(log.append(taskStarted())).toBe(3);
    log.close();

    expect(await readSeqs(path)).toEqual([1, 2, 3]);
  });

  it('skips a complete malformed middle line and continues from the last valid seq', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, `${line(1)}{not json}\n${line(2)}`);

    const log = openLog(runDir);
    expect(log.nextSequence).toBe(3);
    log.close();

    const items = await readAll(path);
    expect(items.map((item) => (item as { status: string }).status)).toEqual([
      'event',
      'invalid',
      'event',
    ]);
  });

  it('keeps (does not truncate) a complete malformed final line, continuing past it', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, `${line(1)}${line(2)}garbage\n`);
    const size = statSync(path).size;

    const log = openLog(runDir);
    expect(statSync(path).size).toBe(size);
    expect(log.append(taskStarted())).toBe(3);
    log.close();
  });

  it('treats a file of nothing but a partial line as empty', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, '{"schema_version":"1","se');

    const log = openLog(runDir);
    expect(statSync(path).size).toBe(0);
    expect(log.append(taskStarted())).toBe(1);
    log.close();
  });

  it('refuses a second outcome on a reopened log whose last record is run_outcome', async () => {
    const runDir = await makeRunDir();
    const first = openLog(runDir);
    first.append(runOutcome());
    first.close();
    appendFileSync(first.path, '{"schema_version":"1","seq":2,');

    const reopened = openLog(runDir);
    expect(() => reopened.append(runOutcome())).toThrow(
      expect.objectContaining({ code: 'RUN_OUTCOME_DUPLICATE' }),
    );
    expect(reopened.append(taskStarted())).toBe(2);
    reopened.close();
  });
});

describe('@no-llm RunEventLog flush points', () => {
  function counting(runDir: string) {
    const scheduler = new ManualScheduler();
    const sync = vi.fn();
    const log = RunEventLog.open({ runDir, runId: 'run-1', sync, scheduler });
    return { log, sync, scheduler };
  }

  it('syncs immediately after an intervention event', async () => {
    const { log, sync } = counting(await makeRunDir());
    log.append(interventionRaised());

    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it.each([
    ['confirmation_requested'],
    ['human_handoff_requested'],
    ['task_completed'],
    ['task_failed'],
  ])('syncs immediately after %s', async (kind) => {
    const { log, sync } = counting(await makeRunDir());
    const event = {
      confirmation_requested: { kind, task_id: 't', at: AT, request: consentRequest },
      human_handoff_requested: { kind, task_id: 't', at: AT, step_id: 's', reason: 'captcha' },
      task_completed: { kind, task_id: 't', at: AT, outputs_keys: [] },
      task_failed: { kind, task_id: 't', at: AT, failure_class: 'unexpected', report_path: 'r' },
    }[kind];
    log.append(event as never);

    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it('syncs immediately after the terminal run_outcome', async () => {
    const { log, sync } = counting(await makeRunDir());
    log.append(runOutcome());

    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it('does not sync 49 ordinary events, and syncs on the 50th', async () => {
    const { log, sync } = counting(await makeRunDir());
    for (let i = 1; i < RUN_EVENTS_SYNC_EVERY; i++) log.append(assistantText(`t${i}`));
    expect(sync).not.toHaveBeenCalled();

    log.append(assistantText('t50'));
    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it('syncs one ordinary event after one second, through the scheduler', async () => {
    const { log, sync, scheduler } = counting(await makeRunDir());
    log.append(assistantText('only'));

    expect(sync).not.toHaveBeenCalled();
    expect(scheduler.pending.map((p) => p.ms)).toEqual([RUN_EVENTS_SYNC_INTERVAL_MS]);
    scheduler.elapse();
    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it('arms one timer for a burst, and clears it when a flush point syncs first', async () => {
    const { log, sync, scheduler } = counting(await makeRunDir());
    log.append(assistantText('a'));
    log.append(assistantText('b'));
    expect(scheduler.pending).toHaveLength(1);

    log.append(runOutcome());
    expect(scheduler.pending).toHaveLength(0);
    expect(sync).toHaveBeenCalledTimes(1);
    log.close();
  });

  it('syncs on close, and close is idempotent', async () => {
    const { log, sync } = counting(await makeRunDir());
    log.append(assistantText('a'));
    log.close();
    log.close();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(log.closed).toBe(true);
  });

  it('logs an interval-sync failure once and keeps the log usable', async () => {
    const scheduler = new ManualScheduler();
    const error = vi.fn();
    let failing = true;
    const log = RunEventLog.open({
      runDir: await makeRunDir(),
      runId: 'run-1',
      scheduler,
      sync: () => {
        if (failing) throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error },
    });
    log.append(assistantText('a'));
    scheduler.elapse();
    log.append(assistantText('b'));
    scheduler.elapse();

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({ event: 'run_events_sync_failed', code: 'EIO' });
    failing = false;
    expect(log.append(assistantText('c'))).toBe(3);
    log.close();
  });
});

describe('@no-llm RunEventLog line cap and refusals', () => {
  it('replaces an oversize event with event_omitted carrying the kind and byte count', async () => {
    const runDir = await makeRunDir();
    const log = openLog(runDir);
    const seq = log.append(assistantText('x'.repeat(MAX_RUN_EVENT_LINE_BYTES)));
    log.close();

    const stored = JSON.parse(readFileSync(log.path, 'utf8')) as {
      seq: number;
      event: { kind: string; original_kind: string; bytes: number; at: string };
    };
    expect(seq).toBe(1);
    expect(stored.event).toEqual({
      kind: 'event_omitted',
      original_kind: 'assistant_text',
      bytes: expect.any(Number) as number,
      at: AT,
    });
    expect(stored.event.bytes).toBeGreaterThan(MAX_RUN_EVENT_LINE_BYTES);
    expect(statSync(log.path).size).toBeLessThan(1024);
  });

  it('keeps an event that fits exactly', async () => {
    const runDir = await makeRunDir();
    const log = openLog(runDir);
    const overhead = Buffer.byteLength(
      `${JSON.stringify({ schema_version: '1', seq: 1, run_id: 'run-1', event: assistantText('') })}\n`,
    );
    log.append(assistantText('y'.repeat(MAX_RUN_EVENT_LINE_BYTES - overhead)));
    log.close();

    expect(statSync(log.path).size).toBe(MAX_RUN_EVENT_LINE_BYTES);
  });

  it('refuses a second run_outcome', async () => {
    const log = openLog(await makeRunDir());
    log.append(runOutcome());

    expect(() => log.append(runOutcome(2))).toThrow(RunEventLogError);
    expect(() => log.append(runOutcome(2))).toThrow(
      expect.objectContaining({ code: 'RUN_OUTCOME_DUPLICATE' }),
    );
    log.close();
  });

  it('throws the typed closed error for an append after close', async () => {
    const log = openLog(await makeRunDir());
    log.close();

    expect(() => log.append(taskStarted())).toThrow(
      expect.objectContaining({ name: 'RunEventLogError', code: 'RUN_EVENT_LOG_CLOSED' }),
    );
  });

  it('refuses an invalid event without consuming a seq', async () => {
    const log = openLog(await makeRunDir());

    expect(() => log.append({ kind: 'goal_echo', display: 'a\u0007b' } as never)).toThrow(
      expect.objectContaining({ code: 'RUN_EVENT_INVALID' }),
    );
    expect(log.append(taskStarted())).toBe(1);
    log.close();
  });

  it('never puts the rejected payload in the error message', async () => {
    const log = openLog(await makeRunDir());
    try {
      log.append({ kind: 'search_completed', query: 'canary-SECRET-value\n' } as never);
    } catch (error) {
      expect((error as Error).message).not.toContain('canary-SECRET-value');
    }
    log.close();
  });

  it('wraps an open failure in RUN_EVENT_LOG_OPEN_FAILED', async () => {
    const runDir = await makeRunDir();
    const notADirectory = join(runDir, 'file');
    writeFileSync(notADirectory, '');

    expect(() => RunEventLog.open({ runDir: notADirectory, runId: 'run-1' })).toThrow(
      expect.objectContaining({ code: 'RUN_EVENT_LOG_OPEN_FAILED' }),
    );
  });
});
