import { z } from 'zod';

/**
 * Live browser view (FEAT-069, plan §6 and §12): screencast frame metadata,
 * frame control messages and the browser-safe frame payload codec.
 *
 * A screencast frame travels as a run-channel frame of type `0x02` (worker →
 * host) and as a binary WebSocket message (host → app). Both carry the same
 * payload: `[meta_len: u16 BE][meta JSON (UTF-8)][JPEG bytes]`.
 *
 * Frames are never persisted and never sent to the model. Every hop drops a
 * frame whose `generation` is below the highest generation announced by
 * `frames.cleared` or `frames.state` (the generation floor rule).
 *
 * This module is browser-safe: it uses `Uint8Array`, `DataView`,
 * `TextEncoder` and `TextDecoder`, never Node's byte-buffer class or a Node
 * built-in, so `@yantra/ui` and the web app can import it (a test pins this).
 */

/** Capability advertised in the D17 `hello` handshake by an owner that serves frames. */
export const FRAMES_CAPABILITY = 'frames/1' as const;

/** Largest frame payload (4 MiB), equal to the run channel's type `0x02` limit. */
export const MAX_FRAME_PAYLOAD_BYTES = 4_194_304 as const;
/** Largest encoded meta JSON (1 KiB). */
export const MAX_FRAME_META_BYTES = 1_024 as const;
/** Bytes of the `meta_len` prefix. */
export const FRAME_META_LENGTH_BYTES = 2 as const;
/** The JPEG start-of-image marker every frame's image part begins with (`\xFF\xD8`). */
export const JPEG_SOI: readonly [number, number] = [0xff, 0xd8];

/** Default `frames.start` size cap (the S1 report's chosen default). */
export const DEFAULT_FRAME_MAX_WIDTH = 1280 as const;
export const DEFAULT_FRAME_MAX_HEIGHT = 800 as const;

/** Run IDs, as `run.subscribe` accepts them. */
const RunId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .describe('The run whose live view is wanted.');

const Generation = z
  .number()
  .int()
  .nonnegative()
  .describe('Frame generation; monotonic per run stream, never reset while the worker lives.');

const FrameSeq = z
  .number()
  .int()
  .nonnegative()
  .describe('Monotonic per run stream over forwarded frames; used for acks.');

/** The `meta JSON` part of a frame payload. */
export const ScreencastFrameMeta = z
  .object({
    generation: Generation.describe('The worker frame generation at capture.'),
    frame_seq: FrameSeq,
    document_epoch: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        "The task page's top-level committed-document epoch at capture; null when unreadable.",
      ),
    captured_at: z
      .string()
      .datetime()
      .describe('Capture instant (ISO-8601 UTC) from the CDP frame timestamp.'),
    width: z.number().int().positive().describe('Decoded JPEG width in device-independent px.'),
    height: z.number().int().positive().describe('Decoded JPEG height in device-independent px.'),
  })
  .strict()
  .describe('Metadata of one screencast frame; encoded at most 1 KiB.');
export type ScreencastFrameMeta = z.infer<typeof ScreencastFrameMeta>;

/** `frames.start`: begin (or resize) this client's live view. */
export const FramesStart = z
  .object({
    max_width: z
      .number()
      .int()
      .min(320)
      .max(1920)
      .default(DEFAULT_FRAME_MAX_WIDTH)
      .describe('Largest frame width the client wants (320–1920, default 1280).'),
    max_height: z
      .number()
      .int()
      .min(240)
      .max(1200)
      .default(DEFAULT_FRAME_MAX_HEIGHT)
      .describe('Largest frame height the client wants (240–1200, default 800).'),
  })
  .strict()
  .describe('Start streaming frames of the task page to this client.');
export type FramesStart = z.infer<typeof FramesStart>;

/** `frames.stop`: end this client's live view. */
export const FramesStop = z.object({}).strict().describe('Stop streaming frames to this client.');
export type FramesStop = z.infer<typeof FramesStop>;

/** `frame.ack`: the client drew or dropped a frame and can take the next one. */
export const FrameAck = z
  .object({ generation: Generation, frame_seq: FrameSeq })
  .strict()
  .describe('Acknowledges one frame; the next frame is sent only after it.');
export type FrameAck = z.infer<typeof FrameAck>;

/** Why frames were cleared. Closed: extended only by a protocol change. */
export const FramesClearedReason = z
  .enum(['protection'])
  .describe('`protection`: a protected screen began.');
export type FramesClearedReason = z.infer<typeof FramesClearedReason>;

/** `frames.cleared`: discard the displayed image now. */
export const FramesCleared = z
  .object({
    generation: Generation.describe(
      'The generation that began with protection; every frame below it is void.',
    ),
    reason: FramesClearedReason,
  })
  .strict()
  .describe('Protection started: discard the displayed image and every older frame.');
export type FramesCleared = z.infer<typeof FramesCleared>;

/** The live view's state, as the worker sees it. */
export const LiveViewStreamState = z
  .enum(['live', 'protected', 'headed', 'no_page', 'unavailable'])
  .describe(
    '`live`: frames flow; `protected`: a protected screen is hidden; `headed`: the run uses a visible window; `no_page`: no task page (background-only run or not yet launched); `unavailable`: see `reason`.',
  );
export type LiveViewStreamState = z.infer<typeof LiveViewStreamState>;

/** Why the live view is unavailable; `none` otherwise. */
export const LiveViewStateReason = z
  .enum(['capture_failed', 'incompatible_worker', 'protection_unverifiable', 'none'])
  .describe(
    '`capture_failed`: the screencast failed; `incompatible_worker`: the run owner does not speak frames/1; `protection_unverifiable`: the focus guard could not be installed, so frames stay hidden; `none`: not unavailable.',
  );
export type LiveViewStateReason = z.infer<typeof LiveViewStateReason>;

/** The page summary the text alternative shows. */
export const LiveViewPage = z
  .object({
    host: z.string().max(253).describe('Host of the task page.'),
    title: z.string().max(200).describe('Sanitized page title, at most 200 characters.'),
  })
  .strict()
  .describe('Current host and title of the task page, for the text alternative.');
export type LiveViewPage = z.infer<typeof LiveViewPage>;

/** `frames.state`: the live view's state changed (additive to plan §6). */
export const FramesState = z
  .object({
    generation: Generation,
    state: LiveViewStreamState,
    reason: LiveViewStateReason,
    page: LiveViewPage.nullable().describe('Null while protected and when no page exists.'),
  })
  .strict()
  .describe('The live view state, sent on start and on every change.');
export type FramesState = z.infer<typeof FramesState>;

/** `frames.subscribe {run_id}` (app → host). */
export const FramesSubscribe = z
  .object({ run_id: RunId })
  .strict()
  .describe('Watch the live view of one attached run in this window.');
export type FramesSubscribe = z.infer<typeof FramesSubscribe>;

/** `frames.unsubscribe {run_id}` (app → host). */
export const FramesUnsubscribe = z
  .object({ run_id: RunId })
  .strict()
  .describe('Stop watching the live view of one run in this window.');
export type FramesUnsubscribe = z.infer<typeof FramesUnsubscribe>;

/** `frames.ack {run_id, generation, frame_seq}` (app → host notification). */
export const FramesWindowAck = FrameAck.extend({ run_id: RunId })
  .strict()
  .describe('A window drew or dropped one frame of a run and can take the next one.');
export type FramesWindowAck = z.infer<typeof FramesWindowAck>;

/** `frames.subscribe` result: the current state, so the window can draw it at once. */
export const FramesSubscribeResult = FramesState.describe(
  'The current live view state of the run.',
);
export type FramesSubscribeResult = z.infer<typeof FramesSubscribeResult>;

/** Why a frame payload could not be encoded or decoded. */
export type FramePayloadErrorCode =
  /** `meta_len` is zero, beyond 1 KiB, or longer than the bytes after it. */
  | 'META_LENGTH_INVALID'
  /** The meta is not UTF-8 JSON or fails {@link ScreencastFrameMeta}. */
  | 'META_INVALID'
  /** The image part does not start with the JPEG SOI marker. */
  | 'NOT_JPEG'
  /** The payload exceeds 4 MiB. */
  | 'PAYLOAD_TOO_LARGE'
  /** The payload is too short to hold a `meta_len`. */
  | 'TRUNCATED';

/** A frame payload failure. `message` never carries image bytes. */
export class FramePayloadError extends Error {
  public override readonly name = 'FramePayloadError';

  public constructor(
    public readonly code: FramePayloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A decoded frame payload; `jpeg` is a view of the input bytes. */
export interface DecodedFramePayload {
  readonly meta: ScreencastFrameMeta;
  readonly jpeg: Uint8Array;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function startsWithSoi(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === JPEG_SOI[0] && bytes[1] === JPEG_SOI[1];
}

/**
 * Encodes one frame payload: `[meta_len: u16 BE][meta JSON][JPEG bytes]`.
 *
 * @throws FramePayloadError `META_INVALID` when `meta` fails the schema,
 *   `META_LENGTH_INVALID` when its JSON exceeds 1 KiB, `NOT_JPEG` when the
 *   image lacks the SOI marker, `PAYLOAD_TOO_LARGE` beyond 4 MiB.
 */
export function encodeFramePayload(meta: ScreencastFrameMeta, jpeg: Uint8Array): Uint8Array {
  const parsed = ScreencastFrameMeta.safeParse(meta);
  if (!parsed.success) {
    throw new FramePayloadError('META_INVALID', 'Frame meta does not match ScreencastFrameMeta.');
  }
  const metaBytes = utf8Encoder.encode(JSON.stringify(parsed.data));
  if (metaBytes.length > MAX_FRAME_META_BYTES) {
    throw new FramePayloadError(
      'META_LENGTH_INVALID',
      `Frame meta of ${metaBytes.length} bytes exceeds ${MAX_FRAME_META_BYTES}.`,
    );
  }
  if (!startsWithSoi(jpeg)) {
    throw new FramePayloadError('NOT_JPEG', 'Frame image does not start with the JPEG SOI marker.');
  }
  const total = FRAME_META_LENGTH_BYTES + metaBytes.length + jpeg.length;
  if (total > MAX_FRAME_PAYLOAD_BYTES) {
    throw new FramePayloadError(
      'PAYLOAD_TOO_LARGE',
      `Frame payload of ${total} bytes exceeds ${MAX_FRAME_PAYLOAD_BYTES}.`,
    );
  }
  const out = new Uint8Array(total);
  new DataView(out.buffer).setUint16(0, metaBytes.length, false);
  out.set(metaBytes, FRAME_META_LENGTH_BYTES);
  out.set(jpeg, FRAME_META_LENGTH_BYTES + metaBytes.length);
  return out;
}

/**
 * Decodes one frame payload. Never throws: a malformed payload returns a
 * {@link FramePayloadError}, which the caller counts and drops.
 */
export function decodeFramePayload(bytes: Uint8Array): DecodedFramePayload | FramePayloadError {
  if (bytes.length > MAX_FRAME_PAYLOAD_BYTES) {
    return new FramePayloadError(
      'PAYLOAD_TOO_LARGE',
      `Frame payload of ${bytes.length} bytes exceeds ${MAX_FRAME_PAYLOAD_BYTES}.`,
    );
  }
  if (bytes.length < FRAME_META_LENGTH_BYTES) {
    return new FramePayloadError('TRUNCATED', 'Frame payload has no meta_len.');
  }
  const metaLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    0,
    false,
  );
  const available = bytes.length - FRAME_META_LENGTH_BYTES;
  if (metaLength === 0 || metaLength > MAX_FRAME_META_BYTES || metaLength > available) {
    return new FramePayloadError(
      'META_LENGTH_INVALID',
      `meta_len ${metaLength} is outside 1..${Math.min(MAX_FRAME_META_BYTES, available)}.`,
    );
  }
  const metaEnd = FRAME_META_LENGTH_BYTES + metaLength;
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decoder.decode(bytes.subarray(FRAME_META_LENGTH_BYTES, metaEnd)));
  } catch {
    return new FramePayloadError('META_INVALID', 'Frame meta is not valid UTF-8 JSON.');
  }
  const meta = ScreencastFrameMeta.safeParse(raw);
  if (!meta.success) {
    return new FramePayloadError('META_INVALID', 'Frame meta does not match ScreencastFrameMeta.');
  }
  const jpeg = bytes.subarray(metaEnd);
  if (!startsWithSoi(jpeg)) {
    return new FramePayloadError(
      'NOT_JPEG',
      'Frame image does not start with the JPEG SOI marker.',
    );
  }
  return { meta: meta.data, jpeg };
}
