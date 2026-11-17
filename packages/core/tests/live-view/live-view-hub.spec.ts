// @no-llm
import { FramesState, ScreencastFrameMeta } from '@yantra/protocol';
import type { Page as PuppeteerPage } from 'puppeteer-core';
import { describe, expect, it, vi } from 'vitest';

import { ScreenProtection, type ProtectedFocusState } from '../../src/browser/screen-protection.js';
import { SensitiveScreenLatch } from '../../src/browser/sensitive-screen-latch.js';
import { LiveViewError } from '../../src/live-view/errors.js';
import type { FocusGuardHandle } from '../../src/live-view/focus-guard.js';
import {
  LIVE_VIEW_TITLE_MAX_CHARS,
  LiveViewHub,
  type LiveViewControlMessage,
  type LiveViewHubOptions,
  type LiveViewSink,
} from '../../src/live-view/live-view-hub.js';
import type {
  ScreencastFrame,
  ScreencastSourceOptions,
} from '../../src/live-view/screencast-source.js';
import {
  TaskPageEvents,
  type TaskPage,
  type TaskPageSource,
} from '../../src/live-view/task-page-source.js';

type Entry =
  | { readonly kind: 'control'; readonly message: LiveViewControlMessage }
  | { readonly kind: 'frame'; readonly meta: ScreencastFrameMeta };

function recordingSink(): LiveViewSink & { readonly log: Entry[] } {
  const log: Entry[] = [];
  return {
    log,
    control: (message) => log.push({ kind: 'control', message }),
    frame: (meta) => log.push({ kind: 'frame', meta }),
  };
}

const frames = (log: readonly Entry[]) =>
  log.flatMap((entry) => (entry.kind === 'frame' ? [entry.meta] : []));
const controls = (log: readonly Entry[]) =>
  log.flatMap((entry) => (entry.kind === 'control' ? [entry.message] : []));
const states = (log: readonly Entry[]) =>
  controls(log).flatMap((message) => (message.type === 'frames.state' ? [message] : []));
const lastState = (log: readonly Entry[]) => states(log).at(-1);

class FakeTaskPage implements TaskPageSource {
  public readonly latch = new SensitiveScreenLatch();
  public readonly screenProtection = new ScreenProtection(this.latch);
  public readonly events = new TaskPageEvents((error) => {
    throw error;
  });
  public page: TaskPage | null;
  public epoch: number | null = 0;

  public constructor(headless = true) {
    this.page = { page: fakePage('a'), headless };
  }

  public current(): TaskPage | null {
    return this.page;
  }

  public topLevelEpoch(): number | null {
    return this.epoch;
  }

  public subscribe(listener: Parameters<TaskPageSource['subscribe']>[0]): () => void {
    return this.events.subscribe(listener);
  }

  public navigate(): void {
    this.epoch = (this.epoch ?? 0) + 1;
    this.events.emit({ kind: 'navigation_committed', epoch: this.epoch });
  }
}

function fakePage(name: string): PuppeteerPage {
  return { name } as unknown as PuppeteerPage;
}

/** Fakes for the stream, a stepped clock, and the hub under test. */
function harness(options: Partial<LiveViewHubOptions> & { readonly guardFails?: boolean } = {}) {
  let now = 1_000_000;
  const captures: { options: ScreencastSourceOptions; stopped: boolean }[] = [];
  const guards: {
    page: PuppeteerPage;
    onFocus: (state: ProtectedFocusState) => void;
    disposed: boolean;
  }[] = [];
  const warn = vi.fn();
  const debug = vi.fn();
  const hub = new LiveViewHub({
    clock: () => now,
    logger: { info: vi.fn(), warn, error: vi.fn(), debug },
    readPage: () => Promise.resolve({ host: 'shop.example', title: 'Checkout' }),
    startCapture: (captureOptions) => {
      const capture = { options: captureOptions, stopped: false };
      captures.push(capture);
      return Promise.resolve({
        stop: () => {
          capture.stopped = true;
          return Promise.resolve();
        },
      });
    },
    installGuard: (page, onFocus) => {
      if (options.guardFails === true) {
        onFocus('unknown');
        return Promise.reject(new LiveViewError('FOCUS_GUARD_UNAVAILABLE', 'no guard'));
      }
      const guard = { page, onFocus, disposed: false };
      guards.push(guard);
      onFocus('clear');
      const handle: FocusGuardHandle = {
        dispose: () => {
          guard.disposed = true;
          return Promise.resolve();
        },
      };
      return Promise.resolve(handle);
    },
    ...options,
  });
  const live = () => captures.filter((capture) => !capture.stopped);
  return {
    hub,
    captures,
    guards,
    warn,
    debug,
    live,
    advance: (ms: number) => (now += ms),
    now: () => now,
    /** One frame from the running capture, captured `agoMs` before now. */
    emit(agoMs = 0, size = { width: 1280, height: 800 }): void {
      const capture = live().at(-1);
      if (capture === undefined) throw new Error('no running capture');
      const frame: ScreencastFrame = {
        jpeg: Uint8Array.from([0xff, 0xd8, 1]),
        capturedAtMs: now - agoMs,
        ...size,
      };
      capture.options.onFrame(frame);
    },
    settle: async () => {
      await hub.idle();
      await new Promise((resolve) => setImmediate(resolve));
      await hub.idle();
    },
  };
}

async function started(sourceHeadless = true) {
  const h = harness();
  const source = new FakeTaskPage(sourceHeadless);
  const sink = recordingSink();
  h.hub.attach(source);
  const client = h.hub.addClient(sink);
  client.start();
  await h.settle();
  h.advance(10);
  return { ...h, source, sink, client };
}

describe('@no-llm LiveViewHub', () => {
  it('captures nothing and guards nothing without a started client', async () => {
    const h = harness();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(recordingSink());
    await h.settle();
    expect(h.captures).toHaveLength(0);
    expect(h.guards).toHaveLength(0);
    expect(h.hub.capturing).toBe(false);
  });

  it('starts the guard and capture for a started client, then streams schema-valid frames', async () => {
    const { hub, guards, live, emit, sink } = await started();
    expect(guards).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.options).toMatchObject({ maxWidth: 1280, maxHeight: 800 });
    expect(hub.capturing).toBe(true);
    emit();
    const [first] = frames(sink.log);
    expect(ScreencastFrameMeta.safeParse(first).success).toBe(true);
    expect(lastState(sink.log)).toMatchObject({ state: 'live', reason: 'none' });
    for (const message of states(sink.log)) {
      const { type: _type, ...body } = message;
      expect(FramesState.safeParse(body).success).toBe(true);
    }
  });

  it('caps the capture at the largest size any started client asked for', async () => {
    const h = harness();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(recordingSink()).start({ max_width: 640, max_height: 400 });
    h.hub.addClient(recordingSink()).start({ max_width: 1600, max_height: 1000 });
    await h.settle();
    expect(h.live().at(-1)!.options).toMatchObject({ maxWidth: 1600, maxHeight: 1000 });
  });

  it('sends frames.state on start with the page summary', async () => {
    const { sink } = await started();
    expect(states(sink.log)[0]).toMatchObject({ type: 'frames.state' });
    expect(lastState(sink.log)).toMatchObject({
      state: 'live',
      page: { host: 'shop.example', title: 'Checkout' },
    });
  });

  it('never offers a late pre-protection frame to any client, and clears every client first', async () => {
    const h = harness();
    const source = new FakeTaskPage();
    const a = recordingSink();
    const b = recordingSink();
    h.hub.attach(source);
    h.hub.addClient(a).start();
    h.hub.addClient(b).start();
    await h.settle();
    h.advance(10);
    const capture = h.live().at(-1)!;
    const capturedBefore = h.now();
    h.advance(5);

    source.latch.latch(0);
    // The frame was captured before the latch but arrives after it.
    capture.options.onFrame({
      jpeg: Uint8Array.from([0xff, 0xd8]),
      capturedAtMs: capturedBefore,
      width: 10,
      height: 10,
    });
    for (const sink of [a, b]) {
      expect(frames(sink.log)).toHaveLength(0);
      expect(controls(sink.log).some((message) => message.type === 'frames.cleared')).toBe(true);
    }
    expect(h.hub.droppedFrames.protected).toBe(1);
    await h.settle();
    expect(capture.stopped).toBe(true);
    expect(lastState(a.log)).toMatchObject({ state: 'protected', page: null });
  });

  it('delivers frames.cleared before any later frame, and resumes only with fresh captures', async () => {
    const { source, sink, live, emit, advance, settle, now, client } = await started();
    emit();
    client.ack({ generation: frames(sink.log)[0]!.generation, frame_seq: 0 });
    source.latch.latch(0);
    await settle();
    const clearedAt = sink.log.findIndex(
      (entry) => entry.kind === 'control' && entry.message.type === 'frames.cleared',
    );
    const cleared = (sink.log[clearedAt] as { message: { generation: number } }).message.generation;

    // A new document clears the latch; capture restarts under a new generation.
    advance(10);
    source.navigate();
    await settle();
    advance(10);
    expect(live()).toHaveLength(1);
    // A capture from before the restart never shows.
    live()[0]!.options.onFrame({
      jpeg: Uint8Array.from([0xff, 0xd8]),
      capturedAtMs: now() - 25,
      width: 10,
      height: 10,
    });
    emit();
    const after = sink.log
      .slice(clearedAt + 1)
      .flatMap((entry) => (entry.kind === 'frame' ? [entry.meta] : []));
    expect(after).toHaveLength(1);
    expect(after[0]!.generation).toBeGreaterThan(cleared);
    expect(lastState(sink.log)).toMatchObject({ state: 'live' });
  });

  it('lets a fast client run while a slow one holds a single unacked frame', async () => {
    const h = harness();
    h.hub.attach(new FakeTaskPage());
    const slow = recordingSink();
    const fast = recordingSink();
    h.hub.addClient(slow).start();
    const fastClient = h.hub.addClient(fast);
    fastClient.start();
    await h.settle();
    for (let index = 0; index < 5; index += 1) {
      h.advance(100);
      h.emit();
      const last = frames(fast.log).at(-1)!;
      fastClient.ack({ generation: last.generation, frame_seq: last.frame_seq });
    }
    expect(frames(fast.log)).toHaveLength(5);
    expect(frames(slow.log)).toHaveLength(1);
  });

  it('hands the newest frame to a client when it acks, dropping the ones in between', async () => {
    const { sink, client, emit, advance } = await started();
    for (let index = 0; index < 4; index += 1) {
      advance(100);
      emit();
    }
    expect(frames(sink.log).map((meta) => meta.frame_seq)).toEqual([0]);
    client.ack({ generation: 1, frame_seq: 0 });
    expect(frames(sink.log).map((meta) => meta.frame_seq)).toEqual([0, 3]);
    client.ack({ generation: 1, frame_seq: 2 });
    expect(frames(sink.log)).toHaveLength(2);
  });

  it('reports headed and never captures a visible window', async () => {
    const { sink, captures, guards } = await started(false);
    expect(lastState(sink.log)).toMatchObject({ state: 'headed', reason: 'none' });
    expect(captures).toHaveLength(0);
    expect(guards).toHaveLength(0);
  });

  it('reports no_page for a run with no task page', async () => {
    const h = harness();
    const sink = recordingSink();
    h.hub.addClient(sink).start();
    await h.settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'no_page', page: null });
    expect(h.captures).toHaveLength(0);
  });

  it('reports no_page before launch and starts streaming once the page exists', async () => {
    const h = harness();
    const source = new FakeTaskPage();
    source.page = null;
    const sink = recordingSink();
    h.hub.attach(source);
    h.hub.addClient(sink).start();
    await h.settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'no_page' });
    source.page = { page: fakePage('a'), headless: true };
    source.events.emit({ kind: 'page_installed' });
    await h.settle();
    expect(h.live()).toHaveLength(1);
    expect(lastState(sink.log)).toMatchObject({ state: 'live' });
  });

  it('turns a guard install failure into unavailable/protection_unverifiable with no frames', async () => {
    const h = harness({ guardFails: true });
    const install = vi.fn(h.hub['options'].installGuard!);
    (h.hub as unknown as { options: LiveViewHubOptions }).options = {
      ...h.hub['options'],
      installGuard: install,
    };
    const sink = recordingSink();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(sink).start();
    await h.settle();
    await h.settle();
    expect(lastState(sink.log)).toMatchObject({
      state: 'unavailable',
      reason: 'protection_unverifiable',
    });
    expect(h.captures).toHaveLength(0);
    expect(install).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]![0]).toMatchObject({ code: 'FOCUS_GUARD_UNAVAILABLE' });
  });

  it('turns a throwing capture start into unavailable/capture_failed, and the run is untouched', async () => {
    const h = harness({
      startCapture: () => Promise.reject(new LiveViewError('CAPTURE_FAILED', 'boom')),
    });
    const sink = recordingSink();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(sink).start();
    await h.settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'unavailable', reason: 'capture_failed' });
    expect(h.warn).toHaveBeenCalledOnce();
  });

  it('retries capture on the next document after a mid-stream failure', async () => {
    const { live, sink, source, settle, captures } = await started();
    live()[0]!.options.onError(new LiveViewError('CAPTURE_FAILED', 'crashed'));
    await settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'unavailable', reason: 'capture_failed' });
    source.navigate();
    await settle();
    expect(captures.filter((capture) => !capture.stopped)).toHaveLength(1);
    expect(lastState(sink.log)).toMatchObject({ state: 'live' });
  });

  it('protects while the guard reports protected or unknown focus', async () => {
    const { guards, sink, settle, live } = await started();
    guards[0]!.onFocus('protected');
    await settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'protected' });
    expect(live()).toHaveLength(0);
    guards[0]!.onFocus('clear');
    await settle();
    expect(live()).toHaveLength(1);
    guards[0]!.onFocus('unknown');
    await settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'protected' });
  });

  it('tears down capture and guard when the last client stops, and resets focus', async () => {
    const h = harness();
    const source = new FakeTaskPage();
    h.hub.attach(source);
    const one = h.hub.addClient(recordingSink());
    const two = h.hub.addClient(recordingSink());
    one.start();
    two.start();
    await h.settle();
    h.guards[0]!.onFocus('unknown');
    one.stop();
    await h.settle();
    expect(h.captures.every((capture) => capture.stopped)).toBe(true);
    two.close();
    await h.settle();
    expect(h.guards[0]!.disposed).toBe(true);
    expect(h.hub.capturing).toBe(false);
    expect(source.screenProtection.focusState).toBe('clear');
  });

  it('bumps the generation on navigation and voids queued older frames', async () => {
    const { sink, emit, client, source, advance, settle, hub } = await started();
    emit();
    advance(10);
    emit();
    const before = hub.generation;
    source.navigate();
    await settle();
    client.ack({ generation: before, frame_seq: 0 });
    // The queued pre-navigation frame is gone.
    expect(frames(sink.log)).toHaveLength(1);
    expect(hub.generation).toBeGreaterThan(before);
  });

  it('re-guards and re-captures a new page on a target change', async () => {
    const { source, settle, guards, live } = await started();
    const next = fakePage('b');
    source.page = { page: next, headless: true };
    source.events.emit({ kind: 'target_changed' });
    await settle();
    expect(guards[0]!.disposed).toBe(true);
    expect(guards.at(-1)!.page).toBe(next);
    expect(live()).toHaveLength(1);
    expect(live()[0]!.options.page).toBe(next);
  });

  it('stops on teardown and reports no_page', async () => {
    const { source, settle, sink, captures } = await started();
    source.page = null;
    source.events.emit({ kind: 'torn_down' });
    await settle();
    expect(captures.every((capture) => capture.stopped)).toBe(true);
    expect(lastState(sink.log)).toMatchObject({ state: 'no_page' });
  });

  it('sanitizes and truncates the title, and never logs it', async () => {
    const h = harness({
      readPage: () =>
        Promise.resolve({
          host: 'mail.example',
          title: `Inbox ${'x'.repeat(400)} sk-ABCDEFGHIJKLMNOPQRSTUVWX`,
        }),
    });
    const sink = recordingSink();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(sink).start();
    await h.settle();
    const page = lastState(sink.log)!.page!;
    expect(page.title.length).toBeLessThanOrEqual(LIVE_VIEW_TITLE_MAX_CHARS);
    expect(page.title.startsWith('Inbox')).toBe(true);
    const logged = JSON.stringify([...h.warn.mock.calls, ...h.debug.mock.calls]);
    expect(logged).not.toContain('Inbox');
    expect(logged).not.toContain('mail.example');
  });

  it('uses the run sanitizer for titles', async () => {
    const sanitizeTitle = vi.fn(() => '[title]');
    const h = harness({ sanitizeTitle });
    const sink = recordingSink();
    h.hub.attach(new FakeTaskPage());
    h.hub.addClient(sink).start();
    await h.settle();
    expect(sanitizeTitle).toHaveBeenCalledWith('Checkout', 'shop.example');
    expect(lastState(sink.log)!.page).toEqual({ host: 'shop.example', title: '[title]' });
  });

  it('drops a client whose sink throws, without disturbing the others', async () => {
    const h = harness();
    h.hub.attach(new FakeTaskPage());
    const good = recordingSink();
    h.hub
      .addClient({
        control: () => {
          throw new Error('socket gone');
        },
        frame: () => undefined,
      })
      .start();
    h.hub.addClient(good).start();
    await h.settle();
    h.advance(10);
    h.emit();
    expect(h.hub.clientCount).toBe(1);
    expect(frames(good.log)).toHaveLength(1);
  });

  it('closes cleanly and ignores later clients', async () => {
    const { hub, captures, guards } = await started();
    await hub.close();
    await hub.close();
    expect(captures.every((capture) => capture.stopped)).toBe(true);
    expect(guards.every((guard) => guard.disposed)).toBe(true);
    const late = recordingSink();
    hub.addClient(late).start();
    expect(late.log).toEqual([]);
  });

  it('gives up, rather than spinning, on a source that hands out a new page every time', async () => {
    const h = harness();
    const source = new FakeTaskPage();
    Object.defineProperty(source, 'page', {
      get: () => ({ page: fakePage('unstable'), headless: true }),
      set: () => undefined,
    });
    const sink = recordingSink();
    h.hub.attach(source);
    h.hub.addClient(sink).start();
    for (let index = 0; index < 20; index += 1) await h.settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'unavailable', reason: 'capture_failed' });
    expect(h.captures.length).toBeLessThan(20);
  });

  it('starts protected when the latch is already set at attach', async () => {
    const h = harness();
    const source = new FakeTaskPage();
    source.latch.latch(0);
    const sink = recordingSink();
    h.hub.attach(source);
    h.hub.addClient(sink).start();
    await h.settle();
    expect(lastState(sink.log)).toMatchObject({ state: 'protected', page: null });
    expect(h.live()).toHaveLength(0);
  });
});
