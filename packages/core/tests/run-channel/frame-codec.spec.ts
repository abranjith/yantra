// @no-llm
/**
 * The run-channel frame codec (FEAT-064 TASK-003, plan §6).
 */

import {
  FRAME_HEADER_BYTES,
  FRAME_TYPE_JSON,
  FRAME_TYPE_SCREENCAST,
  MAX_HELLO_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
  MAX_SCREENCAST_FRAME_BYTES,
} from '@yantra/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FrameDecoder,
  MAX_SCREENCAST_META_BYTES,
  RunChannelFrameError,
  encodeJsonFrame,
  encodeScreencastFrame,
  type DecodedFrame,
} from '../../src/run-channel/index.js';

function header(type: number, length: number): Buffer {
  const bytes = Buffer.alloc(FRAME_HEADER_BYTES);
  bytes.writeUInt8(type, 0);
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

function rawFrame(type: number, payload: Uint8Array): Buffer {
  return Buffer.concat([header(type, payload.length), payload]);
}

function screencastPayload(metaLength: number, rest: Uint8Array): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(metaLength, 0);
  return Buffer.concat([prefix, rest]);
}

function decodeAll(chunks: readonly Uint8Array[], decoder = new FrameDecoder()): DecodedFrame[] {
  return chunks.flatMap((chunk) => decoder.push(chunk));
}

function fatalReason(frames: readonly DecodedFrame[]): string | undefined {
  const last = frames.at(-1);
  return last?.kind === 'fatal' ? last.reason : undefined;
}

const MESSAGE = { type: 'event', seq: 7, event: { kind: 'assistant_text', text: 'naïve ☕' } };
const META = { seq: 3, width: 1280, height: 800, at: '2026-11-09T12:00:00.000Z' };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);

describe('@no-llm encodeJsonFrame', () => {
  it('writes the type byte, a big-endian length, and the UTF-8 JSON payload', () => {
    const frame = encodeJsonFrame(MESSAGE);
    const payload = Buffer.from(JSON.stringify(MESSAGE), 'utf8');
    expect(frame.readUInt8(0)).toBe(FRAME_TYPE_JSON);
    expect(frame.readUInt32BE(1)).toBe(payload.length);
    expect(frame.subarray(FRAME_HEADER_BYTES)).toEqual(payload);
  });

  it('accepts a payload of exactly 1 MiB and refuses one byte more', () => {
    const atLimit = 'x'.repeat(MAX_JSON_FRAME_BYTES - 2); // plus two quotes
    expect(encodeJsonFrame(atLimit).length).toBe(FRAME_HEADER_BYTES + MAX_JSON_FRAME_BYTES);
    expect(() => encodeJsonFrame(`${atLimit}x`)).toThrow(
      expect.objectContaining({ name: 'RunChannelFrameError', code: 'FRAME_TOO_LARGE' }),
    );
  });

  it('counts UTF-8 bytes, not characters, against the limit', () => {
    const multiByte = '€'.repeat(Math.ceil(MAX_JSON_FRAME_BYTES / 3)); // 3 bytes each
    expect(() => encodeJsonFrame(multiByte)).toThrow(RunChannelFrameError);
  });

  it('never puts the payload in the error message', () => {
    const secret = `secret-${'s'.repeat(MAX_JSON_FRAME_BYTES)}`;
    try {
      encodeJsonFrame(secret);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });

  it('refuses a value with no JSON encoding', () => {
    expect(() => encodeJsonFrame(undefined)).toThrow(
      expect.objectContaining({ code: 'FRAME_NOT_JSON' }),
    );
  });
});

describe('@no-llm encodeScreencastFrame', () => {
  it('lays out [meta_len u16][meta JSON][JPEG bytes] under a type 0x02 header', () => {
    const frame = encodeScreencastFrame(META, JPEG);
    const meta = Buffer.from(JSON.stringify(META), 'utf8');
    expect(frame.readUInt8(0)).toBe(FRAME_TYPE_SCREENCAST);
    expect(frame.readUInt32BE(1)).toBe(2 + meta.length + JPEG.length);
    expect(frame.readUInt16BE(FRAME_HEADER_BYTES)).toBe(meta.length);
    expect(frame.subarray(FRAME_HEADER_BYTES + 2, FRAME_HEADER_BYTES + 2 + meta.length)).toEqual(
      meta,
    );
    expect(frame.subarray(FRAME_HEADER_BYTES + 2 + meta.length)).toEqual(JPEG);
  });

  it('refuses meta JSON over 65,535 bytes', () => {
    const meta = 'm'.repeat(MAX_SCREENCAST_META_BYTES - 1); // 65,536 with quotes
    expect(() => encodeScreencastFrame(meta, JPEG)).toThrow(
      expect.objectContaining({ code: 'FRAME_META_TOO_LARGE' }),
    );
    expect(() =>
      encodeScreencastFrame('m'.repeat(MAX_SCREENCAST_META_BYTES - 2), JPEG),
    ).not.toThrow();
  });

  it('accepts a payload of exactly 4 MiB and refuses one byte more', () => {
    const metaLength = Buffer.byteLength(JSON.stringify(META));
    const jpeg = Buffer.alloc(MAX_SCREENCAST_FRAME_BYTES - 2 - metaLength);
    expect(encodeScreencastFrame(META, jpeg).readUInt32BE(1)).toBe(MAX_SCREENCAST_FRAME_BYTES);
    expect(() => encodeScreencastFrame(META, Buffer.alloc(jpeg.length + 1))).toThrow(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    );
  });
});

describe('@no-llm FrameDecoder round trip', () => {
  it('decodes a JSON frame', () => {
    expect(decodeAll([encodeJsonFrame(MESSAGE)])).toEqual([{ kind: 'json', message: MESSAGE }]);
  });

  it('decodes a screencast frame', () => {
    expect(decodeAll([encodeScreencastFrame(META, JPEG)])).toEqual([
      { kind: 'screencast', meta: META, jpeg: JPEG },
    ]);
  });

  it('decodes a screencast frame with no JPEG bytes', () => {
    expect(decodeAll([encodeScreencastFrame(META, Buffer.alloc(0))])).toEqual([
      { kind: 'screencast', meta: META, jpeg: Buffer.alloc(0) },
    ]);
  });

  it('decodes JSON null, which is a valid message body', () => {
    expect(decodeAll([encodeJsonFrame(null)])).toEqual([{ kind: 'json', message: null }]);
  });

  it('decodes a JSON frame of exactly 1 MiB', () => {
    const value = 'x'.repeat(MAX_JSON_FRAME_BYTES - 2);
    expect(decodeAll([encodeJsonFrame(value)])).toEqual([{ kind: 'json', message: value }]);
  });
});

describe('@no-llm FrameDecoder fragmentation and coalescing', () => {
  it('decodes one frame delivered one byte at a time', () => {
    const frame = encodeJsonFrame(MESSAGE);
    const decoder = new FrameDecoder();
    const out: DecodedFrame[] = [];
    for (let index = 0; index < frame.length; index += 1) {
      out.push(...decoder.push(frame.subarray(index, index + 1)));
      if (index < frame.length - 1) {
        expect(out).toEqual([]);
        expect(decoder.buffered).toBe(index + 1);
      }
    }
    expect(out).toEqual([{ kind: 'json', message: MESSAGE }]);
    expect(decoder.buffered).toBe(0);
  });

  it('decodes three frames coalesced in one chunk, in order', () => {
    const chunk = Buffer.concat([
      encodeJsonFrame({ type: 'ping' }),
      encodeScreencastFrame(META, JPEG),
      encodeJsonFrame({ type: 'cancel' }),
    ]);
    expect(decodeAll([chunk])).toEqual([
      { kind: 'json', message: { type: 'ping' } },
      { kind: 'screencast', meta: META, jpeg: JPEG },
      { kind: 'json', message: { type: 'cancel' } },
    ]);
  });

  it.each([1, 3, 4, 5, 6])('decodes a frame split after byte %i (across the header)', (cut) => {
    const frame = encodeJsonFrame(MESSAGE);
    expect(decodeAll([frame.subarray(0, cut), frame.subarray(cut)])).toEqual([
      { kind: 'json', message: MESSAGE },
    ]);
  });

  it('decodes a frame whose tail shares a chunk with the next header', () => {
    const first = encodeJsonFrame({ a: 1 });
    const second = encodeJsonFrame({ b: 2 });
    const both = Buffer.concat([first, second]);
    const cut = first.length + 2;
    const decoder = new FrameDecoder();
    expect(decoder.push(both.subarray(0, 4))).toEqual([]);
    expect(decoder.push(both.subarray(4, cut))).toEqual([{ kind: 'json', message: { a: 1 } }]);
    expect(decoder.buffered).toBe(2);
    expect(decoder.push(both.subarray(cut))).toEqual([{ kind: 'json', message: { b: 2 } }]);
  });

  it('accepts an empty chunk', () => {
    expect(new FrameDecoder().push(Buffer.alloc(0))).toEqual([]);
  });

  it('decodes from a Uint8Array view at a non-zero offset', () => {
    const frame = encodeJsonFrame(MESSAGE);
    const backing = new Uint8Array(frame.length + 8);
    backing.set(frame, 4);
    const view = new Uint8Array(backing.buffer, 4, frame.length);
    expect(decodeAll([view])).toEqual([{ kind: 'json', message: MESSAGE }]);
  });
});

describe('@no-llm FrameDecoder fatal frames', () => {
  it('stops on type 0x03', () => {
    const frames = decodeAll([rawFrame(0x03, Buffer.from('{}'))]);
    expect(frames).toEqual([
      { kind: 'fatal', reason: 'unknown_type', detail: 'Unknown frame type 0x03.' },
    ]);
  });

  it('stops on type 0x00', () => {
    expect(fatalReason(decodeAll([header(0x00, 0)]))).toBe('unknown_type');
  });

  it('refuses a JSON length of 1 MiB + 1 from the header alone, buffering at most 5 bytes', () => {
    const decoder = new FrameDecoder();
    const out = decoder.push(header(FRAME_TYPE_JSON, MAX_JSON_FRAME_BYTES + 1));
    expect(fatalReason(out)).toBe('over_limit');
    expect(decoder.buffered).toBeLessThanOrEqual(FRAME_HEADER_BYTES);
    // Payload bytes that follow are never held.
    expect(decoder.push(Buffer.alloc(64 * 1024))).toEqual([]);
    expect(decoder.buffered).toBe(0);
  });

  it('refuses an over-limit length declared byte by byte before any payload arrives', () => {
    const decoder = new FrameDecoder();
    const bytes = header(FRAME_TYPE_JSON, 0xffffffff);
    const out: DecodedFrame[] = [];
    for (const byte of bytes) {
      out.push(...decoder.push(Uint8Array.of(byte)));
      expect(decoder.buffered).toBeLessThanOrEqual(FRAME_HEADER_BYTES);
    }
    expect(fatalReason(out)).toBe('over_limit');
  });

  it('refuses a screencast length of 4 MiB + 1', () => {
    expect(
      fatalReason(decodeAll([header(FRAME_TYPE_SCREENCAST, MAX_SCREENCAST_FRAME_BYTES + 1)])),
    ).toBe('over_limit');
  });

  it('allows a screencast length above the JSON limit (limits are per type)', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(header(FRAME_TYPE_SCREENCAST, MAX_JSON_FRAME_BYTES + 1))).toEqual([]);
    expect(decoder.failed).toBe(false);
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0x22, 0xff, 0x22])],
    ['a lone UTF-8 continuation byte', Buffer.from([0x22, 0x80, 0x22])],
    ['truncated JSON', Buffer.from('{"type":', 'utf8')],
    ['an empty payload', Buffer.alloc(0)],
  ])('refuses a JSON frame with %s', (_label, payload) => {
    expect(fatalReason(decodeAll([rawFrame(FRAME_TYPE_JSON, payload)]))).toBe('malformed_json');
  });

  it('refuses a meta_len greater than the payload after it', () => {
    const payload = screencastPayload(10, Buffer.from('{}'));
    expect(fatalReason(decodeAll([rawFrame(FRAME_TYPE_SCREENCAST, payload)]))).toBe(
      'malformed_screencast',
    );
  });

  it.each([
    ['a payload shorter than meta_len itself', Buffer.from([0x00])],
    ['an empty meta', screencastPayload(0, JPEG)],
    ['meta that is not JSON', screencastPayload(3, Buffer.from('{x}'))],
    ['meta that is not UTF-8', screencastPayload(3, Buffer.from([0x22, 0xc3, 0x22]))],
  ])('refuses a screencast frame with %s', (_label, payload) => {
    expect(fatalReason(decodeAll([rawFrame(FRAME_TYPE_SCREENCAST, payload)]))).toBe(
      'malformed_screencast',
    );
  });

  it('returns the frames before a fatal one, then nothing more', () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([
      encodeJsonFrame({ type: 'ping' }),
      rawFrame(0x7f, Buffer.from('x')),
      encodeJsonFrame({ type: 'cancel' }),
    ]);
    const out = decoder.push(chunk);
    expect(out.map((frame) => frame.kind)).toEqual(['json', 'fatal']);
    expect(decoder.failed).toBe(true);
    expect(decoder.buffered).toBe(0);
    expect(decoder.push(encodeJsonFrame({ type: 'ping' }))).toEqual([]);
  });
});

describe('@no-llm FrameDecoder per-state limit', () => {
  it('enforces a 16 KiB hello limit on the JSON frame', () => {
    const decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
    expect(fatalReason(decoder.push(header(FRAME_TYPE_JSON, MAX_HELLO_FRAME_BYTES + 1)))).toBe(
      'over_limit',
    );
  });

  it('accepts a hello of exactly 16 KiB', () => {
    const value = 'h'.repeat(MAX_HELLO_FRAME_BYTES - 2);
    const decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
    expect(decoder.push(encodeJsonFrame(value))).toEqual([{ kind: 'json', message: value }]);
  });

  it('applies the state limit to screencast frames too', () => {
    const decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
    expect(
      fatalReason(decoder.push(header(FRAME_TYPE_SCREENCAST, MAX_HELLO_FRAME_BYTES + 1))),
    ).toBe('over_limit');
  });

  it('lifts the limit from the next frame after setLimit(null)', () => {
    const decoder = new FrameDecoder({ limit: MAX_HELLO_FRAME_BYTES });
    expect(decoder.push(encodeJsonFrame({ type: 'hello' }))).toHaveLength(1);
    decoder.setLimit(null);
    const large = 'x'.repeat(MAX_HELLO_FRAME_BYTES * 4);
    expect(decoder.push(encodeJsonFrame(large))).toEqual([{ kind: 'json', message: large }]);
  });

  it('never raises a type limit above its own maximum', () => {
    const decoder = new FrameDecoder({ limit: MAX_SCREENCAST_FRAME_BYTES * 2 });
    expect(fatalReason(decoder.push(header(FRAME_TYPE_JSON, MAX_JSON_FRAME_BYTES + 1)))).toBe(
      'over_limit',
    );
  });
});

type Sent =
  | { readonly kind: 'json'; readonly message: unknown }
  | { readonly kind: 'screencast'; readonly meta: unknown; readonly jpeg: Uint8Array };

const sentFrame: fc.Arbitrary<Sent> = fc.oneof(
  fc.jsonValue().map((message) => ({ kind: 'json' as const, message })),
  fc
    .record({
      meta: fc.dictionary(fc.string(), fc.jsonValue({ maxDepth: 2 })),
      jpeg: fc.uint8Array({ maxLength: 256 }),
    })
    .map(({ meta, jpeg }) => ({ kind: 'screencast' as const, meta, jpeg })),
);

/** What a receiver sees: JSON round-trips normalize values such as -0. */
function expected(frame: Sent): DecodedFrame {
  return frame.kind === 'json'
    ? { kind: 'json', message: JSON.parse(JSON.stringify(frame.message)) as unknown }
    : {
        kind: 'screencast',
        meta: JSON.parse(JSON.stringify(frame.meta)) as unknown,
        jpeg: Buffer.from(frame.jpeg),
      };
}

describe('@no-llm FrameDecoder property', () => {
  it('decodes random frame sequences identically however the bytes are split', () => {
    fc.assert(
      fc.property(
        fc.array(sentFrame, { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        (frames, rawCuts) => {
          const stream = Buffer.concat(
            frames.map((frame) =>
              frame.kind === 'json'
                ? encodeJsonFrame(frame.message)
                : encodeScreencastFrame(frame.meta, frame.jpeg),
            ),
          );
          const cuts = [...new Set(rawCuts.map((cut) => cut % (stream.length + 1)))].sort(
            (a, b) => a - b,
          );
          const chunks: Buffer[] = [];
          let start = 0;
          for (const cut of [...cuts, stream.length]) {
            chunks.push(stream.subarray(start, cut));
            start = cut;
          }
          const decoder = new FrameDecoder();
          expect(decodeAll(chunks, decoder)).toEqual(frames.map(expected));
          expect(decoder.buffered).toBe(0);
        },
      ),
      { numRuns: 300 },
    );
  });
});
