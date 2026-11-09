// @no-llm
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RUN_EVENTS_FILENAME, RunEventLog } from '../../src/run-events/log.js';
import { readRunEvents, scanRunEventsTail } from '../../src/run-events/reader.js';

import {
  AT,
  ManualScheduler,
  assistantText,
  cleanupRunDirs,
  makeRunDir,
  readAll,
} from './support.js';

afterEach(cleanupRunDirs);

function line(
  seq: number,
  event: unknown = { kind: 'task_started', task_id: 't', at: AT },
): string {
  return `${JSON.stringify({ schema_version: '1', seq, run_id: 'run-1', event })}\n`;
}

function lines(from: number, to: number): string {
  let out = '';
  for (let seq = from; seq <= to; seq++) out += line(seq);
  return out;
}

describe('@no-llm readRunEvents', () => {
  it('yields only records with seq >= fromSeq', async () => {
    const runDir = await makeRunDir();
    const log = RunEventLog.open({
      runDir,
      runId: 'run-1',
      sync: () => undefined,
      scheduler: new ManualScheduler(),
    });
    for (let i = 0; i < 1000; i++) log.append(assistantText(`t${i}`));
    log.close();

    const items = (await readAll(log.path, 500)) as { record: { seq: number } }[];
    expect(items).toHaveLength(501);
    expect(items[0]?.record.seq).toBe(500);
    expect(items.at(-1)?.record.seq).toBe(1000);
  });

  it('streams a 50,000-event file and yields every record in order', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, lines(1, 50_000));

    let count = 0;
    let previous = 0;
    for await (const item of readRunEvents(path)) {
      if (item.status !== 'event') throw new Error(`unexpected ${item.status}`);
      expect(item.record.seq).toBe(previous + 1);
      previous = item.record.seq;
      count += 1;
    }
    expect(count).toBe(50_000);
  });

  it('ignores a trailing partial line without anyone reopening the file', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, lines(1, 3));
    appendFileSync(path, '{"schema_version":"1","seq":4,"run_id":"run-1","event":{"ki');

    const items = (await readAll(path)) as { status: string }[];
    expect(items.map((i) => i.status)).toEqual(['event', 'event', 'event']);
  });

  it('yields an unknown kind as unknown_kind and an invalid line as invalid', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(
      path,
      line(1) + line(2, { kind: 'attendance_changed', at: AT }) + '{oops}\n' + line(3),
    );

    const items = (await readAll(path)) as { status: string }[];
    expect(items.map((i) => i.status)).toEqual(['event', 'unknown_kind', 'invalid', 'event']);
  });

  it('skips invalid lines that sit before fromSeq', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, line(1) + 'junk\n' + line(2) + line(3) + 'late junk\n' + line(4));

    const items = (await readAll(path, 3)) as { status: string }[];
    expect(items.map((i) => i.status)).toEqual(['event', 'invalid', 'event']);
  });

  it('tolerates blank lines and CRLF line endings', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, `${line(1)}\n${line(2).replace('\n', '\r\n')}`);

    expect(((await readAll(path)) as { status: string }[]).map((i) => i.status)).toEqual([
      'event',
      'event',
    ]);
  });

  it('yields nothing for a missing file', async () => {
    const runDir = await makeRunDir();

    expect(await readAll(join(runDir, RUN_EVENTS_FILENAME))).toEqual([]);
  });

  it('reads a line split across the stream’s chunk boundary', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const big = line(2, { kind: 'assistant_text', text: 'z'.repeat(200_000), at: AT });
    writeFileSync(path, line(1) + big + line(3));

    const items = (await readAll(path)) as { status: string; record: { seq: number } }[];
    expect(items.map((i) => i.record.seq)).toEqual([1, 2, 3]);
  });
});

describe('@no-llm scanRunEventsTail', () => {
  it('reports an empty summary for a missing or empty file', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const empty = { lastSeq: 0, lastKind: null, validBytes: 0, partialTail: false, size: 0 };

    expect(scanRunEventsTail(path)).toEqual(empty);
    writeFileSync(path, '');
    expect(scanRunEventsTail(path)).toEqual(empty);
  });

  it('reports the last seq, its kind, and where the partial tail starts', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const valid = line(1) + line(2, { kind: 'assistant_text', text: 'hi', at: AT });
    writeFileSync(path, `${valid}{"partial`);

    expect(scanRunEventsTail(path)).toEqual({
      lastSeq: 2,
      lastKind: 'assistant_text',
      validBytes: Buffer.byteLength(valid),
      partialTail: true,
      size: Buffer.byteLength(valid) + '{"partial'.length,
    });
  });

  it('widens its window past a large block of trailing garbage to find the last valid line', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const garbage = `${'g'.repeat(1023)}\n`.repeat(1536); // 1.5 MiB of complete junk lines
    writeFileSync(path, lines(1, 40) + garbage);

    expect(scanRunEventsTail(path)).toMatchObject({ lastSeq: 40, partialTail: false });
  });

  it('finds a final newline far from the end of a long partial line', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    const valid = lines(1, 5);
    writeFileSync(path, valid + 'p'.repeat(300_000));

    expect(scanRunEventsTail(path)).toMatchObject({
      lastSeq: 5,
      validBytes: Buffer.byteLength(valid),
      partialTail: true,
    });
  });

  it('reports lastSeq 0 when no complete line is valid', async () => {
    const runDir = await makeRunDir();
    const path = join(runDir, RUN_EVENTS_FILENAME);
    writeFileSync(path, 'junk\nmore junk\n');

    expect(scanRunEventsTail(path)).toMatchObject({
      lastSeq: 0,
      lastKind: null,
      partialTail: false,
    });
  });
});
