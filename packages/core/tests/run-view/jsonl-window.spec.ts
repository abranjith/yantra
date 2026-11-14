// @no-llm
/**
 * Windowed JSONL reads (FEAT-066 TASK-008): a lazily built sparse index that
 * is never rebuilt for appends, seeks to the nearest checkpoint, line and
 * window caps, partial tails and cache invalidation.
 */

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JSONL_LINE_MAX_BYTES, JSONL_WINDOW_MAX_BYTES } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECKPOINT_LINES,
  NODE_JSONL_WINDOW_FS,
  SparseLineIndex,
  readJsonlWindow,
  type JsonlWindowFs,
} from '../../src/run-view/jsonl-window.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'yantra-jsonl-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function line(n: number): string {
  return JSON.stringify({ seq: n, kind: 'step_started', step_id: `s${String(n)}` });
}

async function file(name: string, lines: number, extra = ''): Promise<string> {
  const path = join(dir, name);
  const body = Array.from({ length: lines }, (_, n) => `${line(n)}\n`).join('');
  await writeFile(path, body + extra);
  return path;
}

/** A filesystem that records every read: position and length. */
function recordingFs(): JsonlWindowFs & {
  reads: { position: number; length: number }[];
  opens: number;
} {
  const reads: { position: number; length: number }[] = [];
  const fs = {
    reads,
    opens: 0,
    open: async (path: string) => {
      fs.opens += 1;
      const handle = await NODE_JSONL_WINDOW_FS.open(path);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await handle.read(buffer, offset, length, position);
          reads.push({ position, length: result.bytesRead });
          return result;
        },
        close: () => handle.close(),
      };
    },
    stat: NODE_JSONL_WINDOW_FS.stat,
    realpath: NODE_JSONL_WINDOW_FS.realpath,
  };
  return fs;
}

describe('readJsonlWindow', () => {
  it('returns the requested lines with their numbers', async () => {
    const path = await file('a.jsonl', 10);
    const window = await readJsonlWindow(path, 3, 4, new SparseLineIndex());

    expect(window.lines.map((item) => item.n)).toEqual([3, 4, 5, 6]);
    expect(window.lines[0]!.text).toBe(line(3));
    expect(window.lines[0]!.truncated_bytes).toBe(0);
    expect(window.from_line).toBe(3);
  });

  it('builds the index lazily: total_complete is false until the end is reached', async () => {
    const path = await file('a.jsonl', 5_000);
    const cache = new SparseLineIndex();

    const first = await readJsonlWindow(path, 0, 200, cache);
    const end = await readJsonlWindow(path, 4_990, 200, cache);

    expect(first.total_complete).toBe(false);
    expect(first.total_lines_known).toBe(200);
    expect(end.total_complete).toBe(true);
    expect(end.total_lines_known).toBe(5_000);
    expect(end.lines.map((item) => item.n)).toEqual(
      Array.from({ length: 10 }, (_, i) => 4_990 + i),
    );
  });

  it('indexes a 50,000-line file once: no byte is scanned twice across windows', async () => {
    const path = await file('big.jsonl', 50_000);
    const builds: boolean[] = [];
    const observed = new SparseLineIndex(16, (event) => builds.push(event.rebuilt));
    const fs = recordingFs();

    for (const from of [0, 10_000, 30_000, 49_900])
      await readJsonlWindow(path, from, 100, observed, fs);

    expect(builds.every((rebuilt) => !rebuilt)).toBe(true);
  });

  it('reads at most one checkpoint span for a window at line 49,900 once indexed', async () => {
    const path = await file('big.jsonl', 50_000);
    const cache = new SparseLineIndex();
    await readJsonlWindow(path, 49_999, 1, cache); // index the whole file
    const fs = recordingFs();

    const window = await readJsonlWindow(path, 49_900, 100, cache, fs);

    expect(window.lines).toHaveLength(100);
    expect(window.lines[0]!.n).toBe(49_900);
    expect(window.lines.at(-1)!.n).toBe(49_999);
    const bytesPerLine = Buffer.byteLength(`${line(49_000)}\n`);
    const span = (CHECKPOINT_LINES + 100) * bytesPerLine;
    const read = fs.reads.reduce((total, item) => total + item.length, 0);
    expect(read).toBeLessThanOrEqual(span + 64 * 1024);
    const checkpoint = Math.floor(49_900 / CHECKPOINT_LINES) * CHECKPOINT_LINES;
    let offset = 0;
    for (let n = 0; n < checkpoint; n++) offset += Buffer.byteLength(`${line(n)}\n`);
    // Reading starts exactly at the nearest checkpoint, never earlier.
    expect(Math.min(...fs.reads.map((item) => item.position))).toBe(offset);
  }, 30_000);

  it('cuts a 100 KiB line at 16 KiB and says how much is left out', async () => {
    const long = JSON.stringify({ blob: 'x'.repeat(100 * 1024) });
    const path = join(dir, 'long.jsonl');
    await writeFile(path, `${line(0)}\n${long}\n${line(2)}\n`);

    const window = await readJsonlWindow(path, 0, 3, new SparseLineIndex());

    const cut = window.lines[1]!;
    expect(Buffer.byteLength(cut.text)).toBe(JSONL_LINE_MAX_BYTES);
    expect(cut.truncated_bytes).toBe(Buffer.byteLength(long) - JSONL_LINE_MAX_BYTES);
    expect(window.lines[2]!.text).toBe(line(2));
  });

  it('never splits a multi-byte character when cutting', async () => {
    const path = join(dir, 'utf8.jsonl');
    await writeFile(path, `${'é'.repeat(JSONL_LINE_MAX_BYTES)}\n`);

    const [cut] = (await readJsonlWindow(path, 0, 1, new SparseLineIndex())).lines;

    expect(cut!.text).not.toContain('�');
    expect(Buffer.byteLength(cut!.text)).toBeLessThanOrEqual(JSONL_LINE_MAX_BYTES);
    expect(Buffer.byteLength(cut!.text) + cut!.truncated_bytes).toBe(JSONL_LINE_MAX_BYTES * 2);
  });

  it('excludes a trailing partial line and reports partial_tail', async () => {
    const path = await file('tail.jsonl', 3, '{"seq": 3, "kind": "ha');

    const window = await readJsonlWindow(path, 0, 10, new SparseLineIndex());

    expect(window.lines.map((item) => item.n)).toEqual([0, 1, 2]);
    expect(window.partial_tail).toBe(true);
    expect(window.total_lines_known).toBe(3);
  });

  it('extends the index when lines are appended, without a rebuild', async () => {
    const path = await file('live.jsonl', 2_000);
    const builds: boolean[] = [];
    const cache = new SparseLineIndex(16, (event) => builds.push(event.rebuilt));
    await readJsonlWindow(path, 1_999, 1, cache);

    await appendFile(path, `${line(2_000)}\n${line(2_001)}\n`);
    const window = await readJsonlWindow(path, 1_999, 10, cache);

    expect(window.lines.map((item) => item.n)).toEqual([1_999, 2_000, 2_001]);
    expect(window.total_lines_known).toBe(2_002);
    expect(builds).not.toContain(true);
  });

  it('rebuilds after the file shrank (an edit, not an append)', async () => {
    const path = await file('edit.jsonl', 100);
    const builds: boolean[] = [];
    const cache = new SparseLineIndex(16, (event) => builds.push(event.rebuilt));
    await readJsonlWindow(path, 0, 100, cache);

    await writeFile(path, `${line(7)}\n`);
    const window = await readJsonlWindow(path, 0, 10, cache);

    expect(window.lines.map((item) => item.text)).toEqual([line(7)]);
    expect(window.total_lines_known).toBe(1);
    expect(builds.at(-1)).toBe(true);
  });

  it('honors the window byte cap', async () => {
    const big = JSON.stringify({ blob: '"'.repeat(15 * 1024) });
    const path = join(dir, 'fat.jsonl');
    await writeFile(path, `${big}\n`.repeat(200));

    const window = await readJsonlWindow(path, 0, 200, new SparseLineIndex());

    expect(window.lines.length).toBeGreaterThan(0);
    expect(window.lines.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(window))).toBeLessThanOrEqual(JSONL_WINDOW_MAX_BYTES);
  });

  it('returns no lines past the end, and scanning there completes the count', async () => {
    const path = await file('a.jsonl', 10);
    const window = await readJsonlWindow(path, 2 ** 31, 10, new SparseLineIndex());
    expect(window.lines).toEqual([]);
    expect(window).toMatchObject({ total_complete: true, total_lines_known: 10 });
  });

  it('handles an empty file and CRLF line endings', async () => {
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '');
    expect(await readJsonlWindow(empty, 0, 5, new SparseLineIndex())).toMatchObject({
      lines: [],
      total_complete: true,
      partial_tail: false,
    });
    const crlf = join(dir, 'crlf.jsonl');
    await writeFile(crlf, '{"a":1}\r\n{"b":2}\r\n');
    expect(
      (await readJsonlWindow(crlf, 0, 5, new SparseLineIndex())).lines.map((l) => l.text),
    ).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('keeps at most its capacity of files', async () => {
    const cache = new SparseLineIndex(2);
    for (const name of ['a', 'b', 'c'])
      await readJsonlWindow(await file(`${name}.jsonl`, 3), 0, 1, cache);
    expect(cache.size).toBe(2);
  });
});
