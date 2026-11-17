// @no-llm
import { EventEmitter } from 'node:events';

import type { CDPSession, Page as PuppeteerPage } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LocalProfileStore } from '../../src/browser/profile-store.js';
import { LocalBrowserProvider } from '../../src/browser/provider.js';
import type { BrowserSession, Logger } from '../../src/browser/types.js';
import { LiveViewError } from '../../src/live-view/errors.js';
import {
  MAX_SCREENCAST_JPEG_BYTES,
  SCREENCAST_DEFAULTS,
  ScreencastSource,
  jpegDimensions,
  type ScreencastFrame,
} from '../../src/live-view/screencast-source.js';
import {
  beginMigrationBrowserFixture,
  type MigrationBrowserFixture,
} from '../helpers/migration-browser.js';

/** A minimal JPEG header: SOI, an APP0 segment, then SOF0 with the given size. */
function jpegHeader(width: number, height: number, padTo = 0): Uint8Array {
  const bytes = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ];
  const out = new Uint8Array(Math.max(bytes.length, padTo));
  out.set(bytes);
  return out;
}

class FakeSession extends EventEmitter {
  public readonly sent: { readonly method: string; readonly params: unknown }[] = [];
  public failOn: string | null = null;
  public detached = false;

  public send(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === this.failOn) return Promise.reject(new Error(`${method} failed`));
    return Promise.resolve({});
  }

  public detach(): Promise<void> {
    this.detached = true;
    return Promise.resolve();
  }

  public frame(
    sessionId: number,
    data: Uint8Array,
    timestamp: number | null = 1_700_000_000.5,
  ): void {
    this.emit('Page.screencastFrame', {
      data: Buffer.from(data).toString('base64'),
      sessionId,
      metadata: { timestamp: timestamp ?? undefined, deviceWidth: 1600, deviceHeight: 1000 },
    });
  }

  public acks(): number[] {
    return this.sent
      .filter((entry) => entry.method === 'Page.screencastFrameAck')
      .map((entry) => (entry.params as { sessionId: number }).sessionId);
  }
}

/** A stepped clock and a scheduler whose tasks run only when time is advanced. */
function steppedScheduler() {
  let now = 0;
  const tasks: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    delays: [] as number[],
    schedule(run: () => void, delayMs: number) {
      this.delays.push(delayMs);
      const task = { at: now + delayMs, run, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const task of tasks.filter((entry) => !entry.cancelled && entry.at <= now)) {
        task.cancelled = true;
        task.run();
      }
    },
  };
}

async function fakeSource(overrides: Partial<Parameters<typeof ScreencastSource.start>[0]> = {}) {
  const session = new FakeSession();
  const frames: ScreencastFrame[] = [];
  const errors: LiveViewError[] = [];
  const clock = steppedScheduler();
  const source = await ScreencastSource.start({
    page: {} as PuppeteerPage,
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
    now: clock.now,
    schedule: clock.schedule.bind(clock),
    createSession: () => Promise.resolve(session as unknown as CDPSession),
    ...overrides,
  });
  return { session, frames, errors, clock, source };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('@no-llm jpegDimensions', () => {
  it('reads the size from a SOF0 marker after other segments', () => {
    expect(jpegDimensions(jpegHeader(1280, 800))).toEqual({ width: 1280, height: 800 });
  });

  it('reads a progressive SOF2 marker', () => {
    const bytes = jpegHeader(640, 480);
    bytes[9] = 0xc2;
    expect(jpegDimensions(bytes)).toEqual({ width: 640, height: 480 });
  });

  it.each([
    ['empty', new Uint8Array(0)],
    ['not a JPEG', new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ['truncated before SOF', jpegHeader(10, 10).subarray(0, 12)],
    ['a zero-length segment', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00])],
  ])('returns null for %s', (_label, bytes) => {
    expect(jpegDimensions(bytes)).toBeNull();
  });
});

describe('@no-llm ScreencastSource with a fake CDP session', () => {
  it('starts with the S1 defaults', async () => {
    const { session } = await fakeSource();
    expect(session.sent[0]).toEqual({
      method: 'Page.startScreencast',
      params: {
        format: 'jpeg',
        quality: SCREENCAST_DEFAULTS.quality,
        maxWidth: SCREENCAST_DEFAULTS.maxWidth,
        maxHeight: SCREENCAST_DEFAULTS.maxHeight,
        everyNthFrame: 1,
      },
    });
  });

  it('decodes a frame: bytes, ms timestamp and JPEG size', async () => {
    const { session, frames } = await fakeSource();
    session.frame(1, jpegHeader(1280, 800, 64), 1_700_000_000.25);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ capturedAtMs: 1_700_000_000_250, width: 1280, height: 800 });
    expect(frames[0]!.jpeg[0]).toBe(0xff);
  });

  it('reports a missing timestamp as null and falls back to the device size', async () => {
    const { session, frames } = await fakeSource();
    session.frame(1, new Uint8Array([0xff, 0xd8, 0x00]), null);
    expect(frames[0]).toMatchObject({ capturedAtMs: null, width: 1600, height: 1000 });
  });

  it('paces acks serially so two in-flight frames never double the rate', async () => {
    const { session, clock } = await fakeSource({ targetFps: 10 });
    session.frame(1, jpegHeader(10, 10));
    session.frame(2, jpegHeader(10, 10));
    expect(clock.delays).toEqual([0, 100]);
    clock.advance(0);
    await flush();
    expect(session.acks()).toEqual([1]);
    clock.advance(99);
    await flush();
    expect(session.acks()).toEqual([1]);
    clock.advance(1);
    await flush();
    expect(session.acks()).toEqual([1, 2]);
  });

  it('keeps the ack rate at or below the target over a burst', async () => {
    const { session, clock } = await fakeSource({ targetFps: 5 });
    for (let id = 1; id <= 20; id += 1) session.frame(id, jpegHeader(10, 10));
    clock.advance(1000);
    await flush();
    // 0 ms, 200, 400, 600, 800, 1000: at most one ack per 200 ms interval.
    expect(session.acks()).toHaveLength(6);
  });

  it('acks immediately once frames arrive slower than the target', async () => {
    const { session, clock } = await fakeSource({ targetFps: 10 });
    session.frame(1, jpegHeader(10, 10));
    clock.advance(500);
    session.frame(2, jpegHeader(10, 10));
    expect(clock.delays).toEqual([0, 0]);
  });

  it('drops an oversize frame but still acks it', async () => {
    const { session, frames, clock, source } = await fakeSource();
    session.frame(7, new Uint8Array(MAX_SCREENCAST_JPEG_BYTES + 1).fill(0xff));
    clock.advance(0);
    await flush();
    expect(frames).toEqual([]);
    expect(source.droppedOversize).toBe(1);
    expect(session.acks()).toEqual([7]);
  });

  it('stops: no more frames, pending acks cancelled, the session detached', async () => {
    const { session, frames, clock, source } = await fakeSource();
    session.frame(1, jpegHeader(10, 10));
    session.frame(2, jpegHeader(10, 10));
    await source.stop();
    await source.stop();
    clock.advance(1000);
    await flush();
    session.frame(3, jpegHeader(10, 10));
    expect(frames).toHaveLength(2);
    expect(session.acks()).toEqual([]);
    expect(session.sent.map((entry) => entry.method)).toContain('Page.stopScreencast');
    expect(session.detached).toBe(true);
    expect(source.running).toBe(false);
  });

  it('turns a failing start into CAPTURE_FAILED and detaches', async () => {
    const session = new FakeSession();
    session.failOn = 'Page.startScreencast';
    await expect(
      ScreencastSource.start({
        page: {} as PuppeteerPage,
        onFrame: () => undefined,
        onError: () => undefined,
        createSession: () => Promise.resolve(session as unknown as CDPSession),
      }),
    ).rejects.toMatchObject({ name: 'LiveViewError', code: 'CAPTURE_FAILED' });
    expect(session.detached).toBe(true);
  });

  it('reports a failing ack once through onError and stops', async () => {
    const { session, errors, clock, source } = await fakeSource();
    session.failOn = 'Page.screencastFrameAck';
    session.frame(1, jpegHeader(10, 10));
    session.frame(2, jpegHeader(10, 10));
    clock.advance(1000);
    await flush();
    await flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LiveViewError);
    expect(errors[0]!.code).toBe('CAPTURE_FAILED');
    expect(source.running).toBe(false);
  });

  it('reports a disconnected session as CAPTURE_FAILED', async () => {
    const { session, errors, source } = await fakeSource();
    session.emit('CDPSession.Disconnected');
    expect(errors.map((error) => error.code)).toEqual(['CAPTURE_FAILED']);
    expect(source.running).toBe(false);
  });

  it('isolates a throwing frame consumer as CAPTURE_FAILED', async () => {
    const { session, errors, source } = await fakeSource({
      onFrame: () => {
        throw new Error('consumer bug');
      },
    });
    expect(() => session.frame(1, jpegHeader(10, 10))).not.toThrow();
    expect(errors.map((error) => error.code)).toEqual(['CAPTURE_FAILED']);
    expect(source.running).toBe(false);
  });
});

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

describe('@no-llm ScreencastSource in real Chrome', () => {
  let fixture: MigrationBrowserFixture;
  let session: BrowserSession;
  let page: PuppeteerPage;

  beforeAll(async () => {
    fixture = await beginMigrationBrowserFixture();
    session = await new LocalBrowserProvider({
      profileStore: new LocalProfileStore(),
      logger: silent,
    }).launch({ profile: { kind: 'ephemeral' }, headless: true, ...fixture.launchOptions });
    page = (await session.newPage()).puppeteerPage!;
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await fixture?.cleanup();
  });

  it('delivers timestamped JPEG frames, and stop ends them', async () => {
    await page.goto('about:blank');
    await page.setContent(
      '<style>@keyframes s{to{transform:rotate(360deg)}}div{width:200px;height:200px;background:#c33;animation:s 1s linear infinite}</style><div></div>',
    );
    const frames: ScreencastFrame[] = [];
    const before = Date.now();
    const source = await ScreencastSource.start({
      page,
      maxWidth: 640,
      maxHeight: 400,
      onFrame: (frame) => frames.push(frame),
      onError: (error) => {
        throw error;
      },
    });
    const deadline = Date.now() + 10_000;
    while (frames.length < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await source.stop();
    const count = frames.length;
    expect(count).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect([frame.jpeg[0], frame.jpeg[1]]).toEqual([0xff, 0xd8]);
      expect(frame.capturedAtMs).not.toBeNull();
      // Wall-clock timebase: the gate compares it with Date.now().
      expect(frame.capturedAtMs!).toBeGreaterThan(before - 5_000);
      expect(frame.width).toBeLessThanOrEqual(640);
      expect(frame.height).toBeLessThanOrEqual(400);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(frames).toHaveLength(count);
  }, 30_000);

  it('rejects with CAPTURE_FAILED, not a raw error, on a closed target', async () => {
    const doomed = (await session.newPage()).puppeteerPage!;
    await doomed.close();
    const error = await ScreencastSource.start({
      page: doomed,
      onFrame: () => undefined,
      onError: () => undefined,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LiveViewError);
    expect((error as LiveViewError).code).toBe('CAPTURE_FAILED');
  }, 30_000);
});
