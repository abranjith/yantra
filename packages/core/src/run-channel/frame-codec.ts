import {
  FRAME_HEADER_BYTES,
  FRAME_TYPE_JSON,
  FRAME_TYPE_SCREENCAST,
  MAX_JSON_FRAME_BYTES,
  MAX_SCREENCAST_FRAME_BYTES,
} from '@yantra/protocol';

/**
 * The run-channel framing grammar (FEAT-064, plan §6):
 * `[type: u8][length: u32 BE][payload]`.
 *
 * - Type `0x01`: a UTF-8 JSON message, at most 1 MiB.
 * - Type `0x02`: a screencast frame, at most 4 MiB, laid out as
 *   `[meta_len: u16 BE][meta JSON][JPEG bytes]`.
 *
 * Any other type, any length over its type's limit, or any payload that does
 * not decode is fatal: the decoder stops and the caller closes the connection.
 */

/** Bytes of the screencast `meta_len` prefix. */
const META_LENGTH_BYTES = 2;
/** Largest screencast meta JSON (`meta_len` is a u16). */
export const MAX_SCREENCAST_META_BYTES = 0xffff;

/** Sentinel for a payload that is not valid UTF-8 JSON (`null` is valid JSON). */
const INVALID: unique symbol = Symbol('invalid');

const MAX_PAYLOAD_BY_TYPE: ReadonlyMap<number, number> = new Map([
  [FRAME_TYPE_JSON, MAX_JSON_FRAME_BYTES],
  [FRAME_TYPE_SCREENCAST, MAX_SCREENCAST_FRAME_BYTES],
]);

export type RunChannelFrameErrorCode =
  /** The encoded payload exceeds its frame type's limit. */
  | 'FRAME_TOO_LARGE'
  /** The screencast meta JSON exceeds the u16 `meta_len`. */
  | 'FRAME_META_TOO_LARGE'
  /** The value has no JSON encoding (for example `undefined`). */
  | 'FRAME_NOT_JSON';

/** An encode failure. `message` never carries the payload. */
export class RunChannelFrameError extends Error {
  public override readonly name = 'RunChannelFrameError';

  public constructor(
    public readonly code: RunChannelFrameErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Why a decoder stopped. The caller closes the connection on any of them. */
export type FrameFatalReason =
  | 'unknown_type'
  | 'over_limit'
  | 'malformed_json'
  | 'malformed_screencast';

export type DecodedFrame =
  | { readonly kind: 'json'; readonly message: unknown }
  /** `jpeg` may be a view of a pushed chunk; copy it to keep it past the chunk's lifetime. */
  | { readonly kind: 'screencast'; readonly meta: unknown; readonly jpeg: Buffer }
  | { readonly kind: 'fatal'; readonly reason: FrameFatalReason; readonly detail: string };

function jsonBytes(value: unknown): Buffer {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) {
    throw new RunChannelFrameError('FRAME_NOT_JSON', 'The value has no JSON encoding.');
  }
  return Buffer.from(text, 'utf8');
}

function frame(type: number, parts: readonly Uint8Array[], length: number): Buffer {
  const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(length, 1);
  return Buffer.concat([header, ...parts], FRAME_HEADER_BYTES + length);
}

/**
 * Encodes one JSON message as a type `0x01` frame.
 *
 * @throws RunChannelFrameError `FRAME_TOO_LARGE` when the UTF-8 JSON exceeds
 *   1 MiB (the owner then sends `event_oversize` instead), or `FRAME_NOT_JSON`.
 */
export function encodeJsonFrame(message: unknown): Buffer {
  const payload = jsonBytes(message);
  if (payload.length > MAX_JSON_FRAME_BYTES) {
    throw new RunChannelFrameError(
      'FRAME_TOO_LARGE',
      `JSON frame payload of ${payload.length} bytes exceeds ${MAX_JSON_FRAME_BYTES}.`,
    );
  }
  return frame(FRAME_TYPE_JSON, [payload], payload.length);
}

/**
 * Encodes one screencast frame as type `0x02`:
 * `[meta_len: u16 BE][meta JSON][JPEG bytes]`.
 *
 * @throws RunChannelFrameError `FRAME_META_TOO_LARGE` when the meta JSON
 *   exceeds 65,535 bytes, `FRAME_TOO_LARGE` when the payload exceeds 4 MiB,
 *   or `FRAME_NOT_JSON`.
 */
export function encodeScreencastFrame(meta: unknown, jpeg: Uint8Array): Buffer {
  const metaBytes = jsonBytes(meta);
  if (metaBytes.length > MAX_SCREENCAST_META_BYTES) {
    throw new RunChannelFrameError(
      'FRAME_META_TOO_LARGE',
      `Screencast meta of ${metaBytes.length} bytes exceeds ${MAX_SCREENCAST_META_BYTES}.`,
    );
  }
  const length = META_LENGTH_BYTES + metaBytes.length + jpeg.length;
  if (length > MAX_SCREENCAST_FRAME_BYTES) {
    throw new RunChannelFrameError(
      'FRAME_TOO_LARGE',
      `Screencast frame payload of ${length} bytes exceeds ${MAX_SCREENCAST_FRAME_BYTES}.`,
    );
  }
  const metaLength = Buffer.allocUnsafe(META_LENGTH_BYTES);
  metaLength.writeUInt16BE(metaBytes.length, 0);
  return frame(FRAME_TYPE_SCREENCAST, [metaLength, metaBytes, jpeg], length);
}

export interface FrameDecoderOptions {
  /**
   * A cap on every payload, applied on top of each type's own limit; `null`
   * means only the type limits. The run socket passes 16 KiB until `hello`
   * authenticates, then lifts it with {@link FrameDecoder.setLimit}.
   */
  readonly limit?: number | null;
}

/**
 * An incremental frame decoder for one connection.
 *
 * It accumulates across chunk boundaries and returns every complete frame in
 * a chunk. The type byte and length are validated as soon as the 5-byte header
 * is in, **before** any payload is buffered, so a declared length over the
 * limit is refused without holding it. After the first fatal result the
 * decoder is spent: it buffers nothing and returns no more frames.
 */
export class FrameDecoder {
  readonly #header = Buffer.alloc(FRAME_HEADER_BYTES);
  #headerFilled = 0;
  /** The current frame, once its header is validated. */
  #frame: { type: number; length: number } | null = null;
  #payload: Buffer[] = [];
  #payloadFilled = 0;
  #limit: number | null;
  #dead = false;
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });

  public constructor(options: FrameDecoderOptions = {}) {
    this.#limit = options.limit ?? null;
  }

  /** Changes the per-state limit; it applies from the next frame header. */
  public setLimit(limit: number | null): void {
    this.#limit = limit;
  }

  /** Bytes held for an incomplete frame (header and payload). */
  public get buffered(): number {
    return this.#headerFilled + this.#payloadFilled;
  }

  /** True after a fatal result. */
  public get failed(): boolean {
    return this.#dead;
  }

  /** Feeds one chunk; returns the frames it completes, ending at the first fatal one. */
  public push(chunk: Uint8Array): DecodedFrame[] {
    const out: DecodedFrame[] = [];
    if (this.#dead) {
      return out;
    }
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      if (this.#frame === null) {
        const take = Math.min(FRAME_HEADER_BYTES - this.#headerFilled, bytes.length - offset);
        bytes.copy(this.#header, this.#headerFilled, offset, offset + take);
        this.#headerFilled += take;
        offset += take;
        if (this.#headerFilled < FRAME_HEADER_BYTES) {
          break;
        }
        const fatal = this.#openFrame();
        if (fatal !== null) {
          out.push(fatal);
          return out;
        }
      }
      const current = this.#frame;
      if (current === null) {
        continue;
      }
      const take = Math.min(current.length - this.#payloadFilled, bytes.length - offset);
      if (take > 0) {
        this.#payload.push(bytes.subarray(offset, offset + take));
        this.#payloadFilled += take;
        offset += take;
      }
      if (this.#payloadFilled === current.length) {
        const decoded = this.#closeFrame(current);
        out.push(decoded);
        if (decoded.kind === 'fatal') {
          return out;
        }
      }
    }
    return out;
  }

  /** Validates a complete header; returns a fatal result or null. */
  #openFrame(): DecodedFrame | null {
    const type = this.#header.readUInt8(0);
    const length = this.#header.readUInt32BE(1);
    const typeLimit = MAX_PAYLOAD_BY_TYPE.get(type);
    if (typeLimit === undefined) {
      return this.#fail(
        'unknown_type',
        `Unknown frame type 0x${type.toString(16).padStart(2, '0')}.`,
      );
    }
    const limit = this.#limit === null ? typeLimit : Math.min(typeLimit, this.#limit);
    if (length > limit) {
      return this.#fail('over_limit', `Frame length ${length} exceeds the limit ${limit}.`);
    }
    this.#frame = { type, length };
    return null;
  }

  #closeFrame(current: { type: number; length: number }): DecodedFrame {
    // A frame that arrived in one chunk stays a view of it; only a fragmented one is copied.
    const [only, ...more] = this.#payload;
    const payload =
      only !== undefined && more.length === 0 ? only : Buffer.concat(this.#payload, current.length);
    this.#frame = null;
    this.#headerFilled = 0;
    this.#payload = [];
    this.#payloadFilled = 0;
    return current.type === FRAME_TYPE_JSON
      ? this.#decodeJson(payload)
      : this.#decodeScreencast(payload);
  }

  #decodeJson(payload: Buffer): DecodedFrame {
    const message = this.#parseJson(payload);
    return message === INVALID
      ? this.#fail('malformed_json', 'The JSON frame is not valid UTF-8 JSON.')
      : { kind: 'json', message };
  }

  #decodeScreencast(payload: Buffer): DecodedFrame {
    if (payload.length < META_LENGTH_BYTES) {
      return this.#fail('malformed_screencast', 'The screencast frame has no meta_len.');
    }
    const metaLength = payload.readUInt16BE(0);
    if (metaLength > payload.length - META_LENGTH_BYTES) {
      return this.#fail(
        'malformed_screencast',
        `meta_len ${metaLength} exceeds the ${payload.length - META_LENGTH_BYTES} bytes after it.`,
      );
    }
    const metaEnd = META_LENGTH_BYTES + metaLength;
    const meta = this.#parseJson(payload.subarray(META_LENGTH_BYTES, metaEnd));
    if (meta === INVALID) {
      return this.#fail('malformed_screencast', 'The screencast meta is not valid UTF-8 JSON.');
    }
    return { kind: 'screencast', meta, jpeg: payload.subarray(metaEnd) };
  }

  #parseJson(bytes: Uint8Array): unknown {
    try {
      return JSON.parse(this.#utf8.decode(bytes)) as unknown;
    } catch {
      return INVALID;
    }
  }

  #fail(reason: FrameFatalReason, detail: string): DecodedFrame {
    this.#dead = true;
    this.#frame = null;
    this.#headerFilled = 0;
    this.#payload = [];
    this.#payloadFilled = 0;
    return { kind: 'fatal', reason, detail };
  }
}
