/**
 * CDP screencast of the task page (FEAT-069 TASK-006).
 *
 * Wraps `Page.startScreencast` on a dedicated CDP session. Each
 * `Page.screencastFrame` is decoded and handed to `onFrame`, then its ack is
 * **paced** so Chrome produces at most the target rate. Chrome keeps about two
 * frames in flight, so acks are scheduled serially, one interval after the
 * previous *scheduled* ack (`nextAckAt = max(now, nextAckAt + interval)`).
 * Pacing from the last *sent* ack lets both in-flight frames be acked together
 * and doubles the rate (spike S1, finding 4).
 *
 * Failures never throw into the run: `start` rejects with
 * `LiveViewError('CAPTURE_FAILED')`, and a failure after start is reported
 * once through `onError`.
 */

import {
  FRAME_META_LENGTH_BYTES,
  MAX_FRAME_META_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
} from '@yantra/protocol';
import type { CDPSession, Page as PuppeteerPage } from 'puppeteer-core';

import { LiveViewError } from './errors.js';

/** Spike S1 defaults (`spike-s1-report.md`, "Chosen defaults"). */
export const SCREENCAST_DEFAULTS = {
  targetFps: 10,
  quality: 70,
  maxWidth: 1280,
  maxHeight: 800,
  everyNthFrame: 1,
} as const;

/** The largest JPEG that still fits a frame payload with the largest meta. */
export const MAX_SCREENCAST_JPEG_BYTES =
  MAX_FRAME_PAYLOAD_BYTES - FRAME_META_LENGTH_BYTES - MAX_FRAME_META_BYTES;

/** One captured frame, before the gate decides whether it may be shown. */
export interface ScreencastFrame {
  readonly jpeg: Uint8Array;
  /** Wall-clock ms from CDP `metadata.timestamp`; null when Chrome gave none. */
  readonly capturedAtMs: number | null;
  readonly width: number;
  readonly height: number;
}

/** Schedules `run` after `delayMs`; returns a cancel function. Injected for stepped-clock tests. */
export type AckScheduler = (run: () => void, delayMs: number) => () => void;

export interface ScreencastSourceOptions {
  readonly page: PuppeteerPage;
  readonly onFrame: (frame: ScreencastFrame) => void;
  /** Called at most once, for a failure after start. */
  readonly onError: (error: LiveViewError) => void;
  readonly targetFps?: number;
  readonly quality?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly everyNthFrame?: number;
  /** Monotonic ms for pacing (default `performance.now`). */
  readonly now?: () => number;
  readonly schedule?: AckScheduler;
  readonly createSession?: (page: PuppeteerPage) => Promise<CDPSession>;
}

interface ScreencastFrameEvent {
  readonly data: string;
  readonly sessionId: number;
  readonly metadata: {
    readonly timestamp?: number;
    readonly deviceWidth?: number;
    readonly deviceHeight?: number;
  };
}

const defaultSchedule: AckScheduler = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};

/**
 * Reads a baseline or progressive JPEG's pixel size from its SOF marker;
 * null when the bytes are not a well-formed JPEG header.
 */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 > bytes.length) return null;
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export class ScreencastSource {
  private session: CDPSession | null = null;
  private stopped = false;
  private failed = false;
  private nextAckAt = Number.NEGATIVE_INFINITY;
  private readonly pendingAcks = new Set<() => void>();
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly schedule: AckScheduler;
  /** Frames over {@link MAX_SCREENCAST_JPEG_BYTES}, dropped and acked. */
  public droppedOversize = 0;
  /** Frames handed to `onFrame`. */
  public delivered = 0;

  private constructor(private readonly options: ScreencastSourceOptions) {
    const fps = options.targetFps ?? SCREENCAST_DEFAULTS.targetFps;
    this.intervalMs = 1000 / Math.max(0.1, fps);
    this.now = options.now ?? (() => performance.now());
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /**
   * Starts the screencast.
   *
   * @throws LiveViewError `CAPTURE_FAILED` when the CDP session or
   *   `Page.startScreencast` fails (for example, the target closed).
   */
  public static async start(options: ScreencastSourceOptions): Promise<ScreencastSource> {
    const source = new ScreencastSource(options);
    try {
      await source.begin();
    } catch (error) {
      await source.stop();
      throw new LiveViewError('CAPTURE_FAILED', 'The task page screencast could not start.', {
        cause: error,
      });
    }
    return source;
  }

  public get running(): boolean {
    return this.session !== null && !this.stopped && !this.failed;
  }

  /** Stops the screencast and detaches. Idempotent; never throws. */
  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const cancel of this.pendingAcks) cancel();
    this.pendingAcks.clear();
    const session = this.session;
    this.session = null;
    if (session === null) return;
    session.off('Page.screencastFrame', this.onFrameEvent);
    // Best effort by design: the target may already be gone.
    await session.send('Page.stopScreencast').catch(() => undefined);
    await session.detach().catch(() => undefined);
  }

  private async begin(): Promise<void> {
    const create = this.options.createSession ?? ((page) => page.createCDPSession());
    const session = await create(this.options.page);
    this.session = session;
    session.on('Page.screencastFrame', this.onFrameEvent);
    session.once('CDPSession.Disconnected', () => {
      this.fail(new Error('The screencast CDP session disconnected.'));
    });
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.options.quality ?? SCREENCAST_DEFAULTS.quality,
      maxWidth: this.options.maxWidth ?? SCREENCAST_DEFAULTS.maxWidth,
      maxHeight: this.options.maxHeight ?? SCREENCAST_DEFAULTS.maxHeight,
      everyNthFrame: this.options.everyNthFrame ?? SCREENCAST_DEFAULTS.everyNthFrame,
    });
  }

  private readonly onFrameEvent = (event: ScreencastFrameEvent): void => {
    if (!this.running) return;
    const jpeg = new Uint8Array(Buffer.from(event.data, 'base64'));
    if (jpeg.length > MAX_SCREENCAST_JPEG_BYTES) {
      this.droppedOversize += 1;
    } else {
      const size = jpegDimensions(jpeg) ?? {
        width: Math.max(1, Math.round(event.metadata.deviceWidth ?? 1)),
        height: Math.max(1, Math.round(event.metadata.deviceHeight ?? 1)),
      };
      const stamp = event.metadata.timestamp;
      this.delivered += 1;
      try {
        this.options.onFrame({
          jpeg,
          capturedAtMs: typeof stamp === 'number' && Number.isFinite(stamp) ? stamp * 1000 : null,
          width: size.width,
          height: size.height,
        });
      } catch (error) {
        this.fail(error);
        return;
      }
    }
    this.scheduleAck(event.sessionId);
  };

  private scheduleAck(frameSessionId: number): void {
    const now = this.now();
    this.nextAckAt = Math.max(now, this.nextAckAt + this.intervalMs);
    const cancel = this.schedule(() => {
      this.pendingAcks.delete(cancel);
      const session = this.session;
      if (session === null || !this.running) return;
      session
        .send('Page.screencastFrameAck', { sessionId: frameSessionId })
        .catch((error: unknown) => {
          this.fail(error);
        });
    }, this.nextAckAt - now);
    this.pendingAcks.add(cancel);
  }

  private fail(cause: unknown): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.options.onError(
      new LiveViewError('CAPTURE_FAILED', 'The task page screencast stopped unexpectedly.', {
        cause,
      }),
    );
    void this.stop();
  }
}
