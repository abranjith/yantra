// @no-llm
import { readFileSync } from 'node:fs';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MAX_SCREENCAST_FRAME_BYTES,
  RunChannelClientMessage,
  RunChannelServerMessage,
} from '../../src/index.js';
import {
  DEFAULT_FRAME_MAX_HEIGHT,
  DEFAULT_FRAME_MAX_WIDTH,
  FRAMES_CAPABILITY,
  FrameAck,
  FramePayloadError,
  FramesCleared,
  FramesStart,
  FramesState,
  FramesStop,
  FramesSubscribe,
  FramesUnsubscribe,
  MAX_FRAME_META_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
  ScreencastFrameMeta,
  decodeFramePayload,
  encodeFramePayload,
  type DecodedFramePayload,
} from '../../src/schemas/screencast.js';

const meta = (overrides: Partial<ScreencastFrameMeta> = {}): ScreencastFrameMeta => ({
  generation: 3,
  frame_seq: 17,
  document_epoch: 2,
  captured_at: '2026-11-15T10:00:00.000Z',
  width: 1280,
  height: 800,
  ...overrides,
});

/** A minimal SOI-prefixed byte string; the codec checks the marker, not the image. */
const jpeg = (size = 16): Uint8Array => {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  for (let index = 2; index < size; index += 1) bytes[index] = index % 251;
  return bytes;
};

/** Hand-builds a payload so malformed layouts can be tested. */
const rawPayload = (metaLength: number, metaBytes: Uint8Array, image: Uint8Array): Uint8Array => {
  const out = new Uint8Array(2 + metaBytes.length + image.length);
  new DataView(out.buffer).setUint16(0, metaLength, false);
  out.set(metaBytes, 2);
  out.set(image, 2 + metaBytes.length);
  return out;
};

const encodeMeta = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function expectDecoded(result: DecodedFramePayload | FramePayloadError): DecodedFramePayload {
  if (result instanceof FramePayloadError) throw result;
  return result;
}

function expectError(result: DecodedFramePayload | FramePayloadError): FramePayloadError {
  expect(result).toBeInstanceOf(FramePayloadError);
  return result as FramePayloadError;
}

describe('screencast constants', () => {
  it('advertises frames/1 and matches the run channel 4 MiB frame limit', () => {
    expect(FRAMES_CAPABILITY).toBe('frames/1');
    expect(MAX_FRAME_PAYLOAD_BYTES).toBe(MAX_SCREENCAST_FRAME_BYTES);
    expect(MAX_FRAME_META_BYTES).toBe(1024);
  });
});

describe('ScreencastFrameMeta', () => {
  it('accepts a full meta and a null document epoch', () => {
    expect(ScreencastFrameMeta.parse(meta())).toEqual(meta());
    expect(ScreencastFrameMeta.parse(meta({ document_epoch: null })).document_epoch).toBeNull();
  });

  it.each([
    ['negative generation', { generation: -1 }],
    ['fractional frame_seq', { frame_seq: 1.5 }],
    ['zero width', { width: 0 }],
    ['non-UTC captured_at', { captured_at: '2026-11-15T10:00:00+02:00' }],
    ['non-date captured_at', { captured_at: 'yesterday' }],
  ])('rejects %s', (_label, overrides) => {
    expect(
      ScreencastFrameMeta.safeParse(meta(overrides as Partial<ScreencastFrameMeta>)).success,
    ).toBe(false);
  });

  it('rejects an extra field (strict)', () => {
    expect(ScreencastFrameMeta.safeParse({ ...meta(), url: 'https://x.test' }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    const { captured_at: _dropped, ...rest } = meta();
    expect(ScreencastFrameMeta.safeParse(rest).success).toBe(false);
  });
});

describe('control messages', () => {
  it('fills frames.start defaults and bounds the size', () => {
    expect(FramesStart.parse({})).toEqual({
      max_width: DEFAULT_FRAME_MAX_WIDTH,
      max_height: DEFAULT_FRAME_MAX_HEIGHT,
    });
    expect(FramesStart.safeParse({ max_width: 319 }).success).toBe(false);
    expect(FramesStart.safeParse({ max_width: 1921 }).success).toBe(false);
    expect(FramesStart.safeParse({ max_height: 239 }).success).toBe(false);
    expect(FramesStart.safeParse({ max_height: 1201 }).success).toBe(false);
    expect(FramesStart.parse({ max_width: 320, max_height: 1200 })).toEqual({
      max_width: 320,
      max_height: 1200,
    });
  });

  it('keeps frames.stop empty and strict', () => {
    expect(FramesStop.parse({})).toEqual({});
    expect(FramesStop.safeParse({ now: true }).success).toBe(false);
  });

  it('validates frame.ack', () => {
    expect(FrameAck.parse({ generation: 0, frame_seq: 0 })).toEqual({
      generation: 0,
      frame_seq: 0,
    });
    expect(FrameAck.safeParse({ generation: -1, frame_seq: 0 }).success).toBe(false);
  });

  it('accepts frames.cleared only with the protection reason', () => {
    expect(FramesCleared.parse({ generation: 4, reason: 'protection' }).reason).toBe('protection');
    expect(FramesCleared.safeParse({ generation: 4, reason: 'navigation' }).success).toBe(false);
    expect(FramesCleared.safeParse({ generation: 4, reason: 'protection', extra: 1 }).success).toBe(
      false,
    );
  });

  it('accepts every frames.state state and reason, with or without a page', () => {
    for (const state of ['live', 'protected', 'headed', 'no_page', 'unavailable'] as const) {
      expect(
        FramesState.safeParse({ generation: 1, state, reason: 'none', page: null }).success,
      ).toBe(true);
    }
    for (const reason of [
      'capture_failed',
      'incompatible_worker',
      'protection_unverifiable',
      'none',
    ] as const) {
      expect(
        FramesState.safeParse({ generation: 1, state: 'unavailable', reason, page: null }).success,
      ).toBe(true);
    }
    expect(
      FramesState.parse({
        generation: 1,
        state: 'live',
        reason: 'none',
        page: { host: 'example.test', title: 'Example' },
      }).page,
    ).toEqual({ host: 'example.test', title: 'Example' });
  });

  it('rejects an unknown state, an unknown reason, an over-long title or host', () => {
    const base = { generation: 1, state: 'live', reason: 'none', page: null };
    expect(FramesState.safeParse({ ...base, state: 'paused' }).success).toBe(false);
    expect(FramesState.safeParse({ ...base, reason: 'oops' }).success).toBe(false);
    expect(
      FramesState.safeParse({ ...base, page: { host: 'a.test', title: 'x'.repeat(201) } }).success,
    ).toBe(false);
    expect(
      FramesState.safeParse({ ...base, page: { host: 'h'.repeat(254), title: 't' } }).success,
    ).toBe(false);
    expect(
      FramesState.safeParse({ ...base, page: { host: 'a.test', title: 't', url: 'u' } }).success,
    ).toBe(false);
  });

  it('validates the run id of frames.subscribe and frames.unsubscribe', () => {
    expect(FramesSubscribe.parse({ run_id: 'run_2026-11-15_abc' }).run_id).toBe(
      'run_2026-11-15_abc',
    );
    expect(FramesSubscribe.safeParse({ run_id: '../escape' }).success).toBe(false);
    expect(FramesUnsubscribe.safeParse({ run_id: '' }).success).toBe(false);
    expect(FramesUnsubscribe.safeParse({ run_id: 'r1', extra: true }).success).toBe(false);
  });
});

describe('run channel registration', () => {
  it('parses the frame control messages as known client messages', () => {
    expect(RunChannelClientMessage.parse({ type: 'frames.start' })).toEqual({
      type: 'frames.start',
      max_width: 1280,
      max_height: 800,
    });
    expect(RunChannelClientMessage.parse({ type: 'frames.stop' })).toEqual({ type: 'frames.stop' });
    expect(
      RunChannelClientMessage.parse({ type: 'frame.ack', generation: 2, frame_seq: 9 }),
    ).toEqual({ type: 'frame.ack', generation: 2, frame_seq: 9 });
  });

  it('rejects a malformed known client message rather than passing it through', () => {
    expect(RunChannelClientMessage.safeParse({ type: 'frame.ack', generation: -1 }).success).toBe(
      false,
    );
    expect(RunChannelClientMessage.safeParse({ type: 'frames.start', max_width: 10 }).success).toBe(
      false,
    );
  });

  it('parses frames.cleared and frames.state as known server messages', () => {
    expect(
      RunChannelServerMessage.parse({
        type: 'frames.cleared',
        generation: 5,
        reason: 'protection',
      }),
    ).toEqual({ type: 'frames.cleared', generation: 5, reason: 'protection' });
    expect(
      RunChannelServerMessage.safeParse({
        type: 'frames.state',
        generation: 5,
        state: 'protected',
        reason: 'none',
        page: null,
      }).success,
    ).toBe(true);
    expect(
      RunChannelServerMessage.safeParse({ type: 'frames.cleared', generation: 5, reason: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('frame payload codec', () => {
  it('round-trips meta and image bytes', () => {
    const image = jpeg(64);
    const decoded = expectDecoded(decodeFramePayload(encodeFramePayload(meta(), image)));
    expect(decoded.meta).toEqual(meta());
    expect([...decoded.jpeg]).toEqual([...image]);
  });

  it('round-trips a null document epoch', () => {
    const decoded = expectDecoded(
      decodeFramePayload(encodeFramePayload(meta({ document_epoch: null }), jpeg())),
    );
    expect(decoded.meta.document_epoch).toBeNull();
  });

  it('writes meta_len as a big-endian u16', () => {
    const payload = encodeFramePayload(meta(), jpeg());
    const metaLength = encodeMeta(meta()).length;
    expect(payload[0]).toBe(metaLength >> 8);
    expect(payload[1]).toBe(metaLength & 0xff);
  });

  it('decodes a payload that is a view into a larger buffer', () => {
    const payload = encodeFramePayload(meta(), jpeg(32));
    const host = new Uint8Array(payload.length + 10);
    host.set(payload, 7);
    const decoded = expectDecoded(decodeFramePayload(host.subarray(7, 7 + payload.length)));
    expect(decoded.meta.frame_seq).toBe(17);
    expect(decoded.jpeg.length).toBe(32);
  });

  it('rejects meta_len larger than the bytes after it', () => {
    const metaBytes = encodeMeta(meta());
    const error = expectError(
      decodeFramePayload(rawPayload(metaBytes.length + 50, metaBytes, new Uint8Array(0))),
    );
    expect(error.code).toBe('META_LENGTH_INVALID');
  });

  it('rejects meta_len zero', () => {
    expect(expectError(decodeFramePayload(rawPayload(0, new Uint8Array(0), jpeg()))).code).toBe(
      'META_LENGTH_INVALID',
    );
  });

  it('rejects meta_len beyond 1 KiB even when the bytes exist', () => {
    const big = new Uint8Array(MAX_FRAME_META_BYTES + 1).fill(0x20);
    expect(
      expectError(decodeFramePayload(rawPayload(MAX_FRAME_META_BYTES + 1, big, jpeg()))).code,
    ).toBe('META_LENGTH_INVALID');
  });

  it('rejects a payload too short for meta_len', () => {
    expect(expectError(decodeFramePayload(new Uint8Array([0x00]))).code).toBe('TRUNCATED');
    expect(expectError(decodeFramePayload(new Uint8Array(0))).code).toBe('TRUNCATED');
  });

  it('rejects a payload over 4 MiB on decode', () => {
    const huge = new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1);
    expect(expectError(decodeFramePayload(huge)).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('refuses to encode a payload over 4 MiB', () => {
    expect(() => encodeFramePayload(meta(), jpeg(MAX_FRAME_PAYLOAD_BYTES))).toThrow(
      expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }) as Error,
    );
  });

  it('accepts a payload of exactly 4 MiB', () => {
    const metaLength = encodeMeta(meta()).length;
    const image = jpeg(MAX_FRAME_PAYLOAD_BYTES - 2 - metaLength);
    const payload = encodeFramePayload(meta(), image);
    expect(payload.length).toBe(MAX_FRAME_PAYLOAD_BYTES);
    expect(expectDecoded(decodeFramePayload(payload)).jpeg.length).toBe(image.length);
  });

  it('rejects non-JPEG image bytes on encode and decode', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(() => encodeFramePayload(meta(), png)).toThrow(FramePayloadError);
    const metaBytes = encodeMeta(meta());
    expect(expectError(decodeFramePayload(rawPayload(metaBytes.length, metaBytes, png))).code).toBe(
      'NOT_JPEG',
    );
    expect(
      expectError(decodeFramePayload(rawPayload(metaBytes.length, metaBytes, new Uint8Array(0))))
        .code,
    ).toBe('NOT_JPEG');
  });

  it('rejects meta that is not JSON or not UTF-8', () => {
    const notJson = new TextEncoder().encode('{generation:');
    expect(expectError(decodeFramePayload(rawPayload(notJson.length, notJson, jpeg()))).code).toBe(
      'META_INVALID',
    );
    const badUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    expect(expectError(decodeFramePayload(rawPayload(badUtf8.length, badUtf8, jpeg()))).code).toBe(
      'META_INVALID',
    );
  });

  it('rejects meta that fails the schema (extra field, unknown shape, negative generation)', () => {
    for (const bad of [
      { ...meta(), extra: 1 },
      { hello: 'world' },
      { ...meta(), generation: -2 },
    ]) {
      const bytes = encodeMeta(bad);
      expect(expectError(decodeFramePayload(rawPayload(bytes.length, bytes, jpeg()))).code).toBe(
        'META_INVALID',
      );
    }
  });

  it('refuses to encode invalid meta', () => {
    expect(() => encodeFramePayload({ ...meta(), generation: -1 }, jpeg())).toThrow(
      expect.objectContaining({ code: 'META_INVALID' }) as Error,
    );
  });

  it('never puts image bytes in an error message', () => {
    const error = expectError(decodeFramePayload(new Uint8Array([0x00, 0x05, 1, 2, 3])));
    expect(error.message).not.toMatch(/\[object|\\x/u);
    expect(error.name).toBe('FramePayloadError');
  });

  it('round-trips any valid meta with any SOI-prefixed image (property)', () => {
    const metaArb = fc.record({
      generation: fc.nat(),
      frame_seq: fc.nat(),
      document_epoch: fc.option(fc.nat(), { nil: null }),
      captured_at: fc
        .date({
          min: new Date('2000-01-01T00:00:00Z'),
          max: new Date('2100-01-01T00:00:00Z'),
          noInvalidDate: true,
        })
        .map((date) => date.toISOString()),
      width: fc.integer({ min: 1, max: 10_000 }),
      height: fc.integer({ min: 1, max: 10_000 }),
    });
    const imageArb = fc
      .uint8Array({ maxLength: 2048 })
      .map((tail) => Uint8Array.from([0xff, 0xd8, ...tail]));
    fc.assert(
      fc.property(metaArb, imageArb, (frameMeta, image) => {
        const decoded = expectDecoded(decodeFramePayload(encodeFramePayload(frameMeta, image)));
        expect(decoded.meta).toEqual(frameMeta);
        expect(decoded.jpeg).toEqual(image);
      }),
      { numRuns: 300 },
    );
  });

  it('never throws on arbitrary bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const result = decodeFramePayload(bytes);
        expect(result instanceof FramePayloadError || 'meta' in result).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('browser safety', () => {
  it('does not import or reference Node Buffer or node: built-ins', () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, '..', '..', 'src', 'schemas', 'screencast.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/\bBuffer\b/u);
    expect(source).not.toMatch(/require\(/u);
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/gu)].map(
      (match) => match[1],
    );
    // zod only: the app imports this module as `@yantra/protocol/screencast`.
    expect(specifiers).toEqual(['zod']);
  });

  it('is exported as the browser-safe @yantra/protocol/screencast subpath', () => {
    const manifest = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { exports: Record<string, { import: string }> };
    expect(manifest.exports['./screencast']?.import).toBe('./dist/schemas/screencast.js');
  });
});
