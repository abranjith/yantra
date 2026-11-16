/**
 * The live-view evidence helpers (FEAT-069 TASK-012): the frame byte scan and
 * the arrival-rate sampler.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { arrivalRate, findJpegSignature, scanForFrames } from './privacy-scan.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yantra-frame-scan-'));
  dirs.push(dir);
  return dir;
}

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('findJpegSignature', () => {
  it('finds the signature anywhere, including at the very end', () => {
    expect(findJpegSignature(Buffer.concat([Buffer.from('abc'), JPEG_HEAD]))).toBe(3);
    expect(findJpegSignature(Buffer.from([0x00, 0xff, 0xd8, 0xff]))).toBe(1);
  });

  it('needs all three bytes', () => {
    expect(findJpegSignature(Buffer.from([0xff, 0xd8]))).toBe(-1);
    expect(findJpegSignature(Buffer.from([0xff, 0xd8, 0x00, 0xff]))).toBe(-1);
    expect(findJpegSignature(new Uint8Array(0))).toBe(-1);
  });
});

describe('scanForFrames', () => {
  it('finds JPEG bytes planted in a non-image artifact, in a nested directory', () => {
    const root = sandbox();
    mkdirSync(join(root, 'agent'));
    writeFileSync(
      join(root, 'agent', 'session.jsonl'),
      Buffer.concat([Buffer.from('{"x":1}\n'), JPEG_HEAD]),
    );
    expect(scanForFrames(root)).toEqual([
      { path: 'agent/session.jsonl', reason: 'jpeg_bytes', offset: 8 },
    ]);
  });

  it('ignores the image artifacts a run legitimately owns', () => {
    const root = sandbox();
    mkdirSync(join(root, 'captures'));
    writeFileSync(join(root, 'captures', 'shot-1.jpg'), JPEG_HEAD);
    writeFileSync(join(root, 'captures', 'page.PNG'), JPEG_HEAD);
    expect(scanForFrames(root)).toEqual([]);
  });

  it('flags a file named for frames even when it is empty', () => {
    const root = sandbox();
    writeFileSync(join(root, 'frame-0001.bin'), '');
    writeFileSync(join(root, 'Screencast.log'), 'text');
    const found = scanForFrames(root)
      .map((leak) => `${leak.path}:${leak.reason}`)
      .sort();
    expect(found).toEqual(['Screencast.log:frame_named', 'frame-0001.bin:frame_named']);
  });

  it('handles empty and large files', () => {
    const root = sandbox();
    writeFileSync(join(root, 'empty.json'), '');
    const large = Buffer.alloc(3 * 1024 * 1024, 0x41);
    JPEG_HEAD.copy(large, large.length - 3, 0, 3);
    writeFileSync(join(root, 'large.jsonl'), large);
    expect(scanForFrames(root)).toEqual([
      { path: 'large.jsonl', reason: 'jpeg_bytes', offset: large.length - 3 },
    ]);
  });
});

describe('arrivalRate', () => {
  it('is zero for fewer than two arrivals or no span', () => {
    expect(arrivalRate([])).toBe(0);
    expect(arrivalRate([10])).toBe(0);
    expect(arrivalRate([10, 10])).toBe(0);
  });

  it('is intervals over the span', () => {
    expect(arrivalRate([0, 100, 200, 300, 400, 500])).toBe(10);
    expect(arrivalRate([1_000, 1_200, 1_400])).toBe(5);
  });
});
