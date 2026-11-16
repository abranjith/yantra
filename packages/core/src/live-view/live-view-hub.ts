/**
 * Per-run live-view hub (FEAT-069 TASK-007).
 *
 * One hub per run, created by whoever runs the handler and passed down as an
 * optional dependency. The orchestrator calls {@link LiveViewHub.attach} with
 * its {@link TaskPageSource} once one exists. Clients (run-socket connections,
 * through the worker) {@link LiveViewHub.addClient} a sink and `start`, `stop`
 * and `ack` frames.
 *
 * Rules:
 * - **Zero cost when idle.** The screencast and the focus guard exist only
 *   while at least one client is started; the last stop tears both down.
 * - **Protection first.** On protection start the hub, synchronously, empties
 *   every client's frame slot and sends `frames.cleared`, and only then stops
 *   the screencast, so pixels stop at the source as well as at the gate. On
 *   clear it restarts the screencast under a new generation.
 * - **Latest wins, per client.** Each client has one frame slot and one frame
 *   in flight; a frame is offered only after the client acked the previous one,
 *   so a slow client never delays another.
 * - **Isolated from the run.** Every failure becomes `frames.state
 *   unavailable` with a reason, logged once at `warn` with its code; nothing
 *   here can throw into the run or change its outcome. Logs carry lifecycle and
 *   counts only, never frame bytes or page titles.
 */

import type {
  FrameAck,
  FramesCleared,
  FramesStart,
  FramesState,
  LiveViewPage,
  LiveViewStateReason,
  LiveViewStreamState,
  ScreencastFrameMeta,
} from '@yantra/protocol';
import type { Page as PuppeteerPage } from 'puppeteer-core';

import type { ProtectedFocusState } from '../browser/screen-protection.js';
import type { Logger } from '../browser/types.js';
import { sanitize } from '../sanitizer/index.js';

import { LiveViewError, type LiveViewErrorCode } from './errors.js';
import { installFocusGuard, type FocusGuardHandle } from './focus-guard.js';
import { FrameGate, type FrameDropReason, type FrameGateSignal } from './frame-gate.js';
import {
  ScreencastSource,
  SCREENCAST_DEFAULTS,
  type ScreencastFrame,
  type ScreencastSourceOptions,
} from './screencast-source.js';
import type { TaskPage, TaskPageEvent, TaskPageSource } from './task-page-source.js';

/** Longest page title sent for the text alternative. */
export const LIVE_VIEW_TITLE_MAX_CHARS = 200;
/** Longest host sent for the text alternative. */
export const LIVE_VIEW_HOST_MAX_CHARS = 253;

/** A control message, ready for the run socket's control queue. */
export type LiveViewControlMessage =
  | ({ readonly type: 'frames.cleared' } & FramesCleared)
  | ({ readonly type: 'frames.state' } & FramesState);

/** Where the hub delivers one client's messages. Must not throw; a throw drops the client. */
export interface LiveViewSink {
  /** `frames.cleared` and `frames.state`; delivered ahead of any later frame. */
  control(message: LiveViewControlMessage): void;
  /** One admitted frame; the next comes only after this one is acked. */
  frame(meta: ScreencastFrameMeta, jpeg: Uint8Array): void;
}

/** One client's handle. */
export interface LiveViewClient {
  start(request?: Partial<FramesStart>): void;
  stop(): void;
  ack(ack: FrameAck): void;
  /** Removes the client (a disconnect). Idempotent. */
  close(): void;
}

/** The running screencast as the hub sees it. */
export interface LiveViewCapture {
  stop(): Promise<void>;
}

export interface LiveViewHubOptions {
  readonly logger?: Logger;
  /** Wall-clock ms, the timebase of CDP capture times (default `Date.now`). */
  readonly clock?: () => number;
  /** Sanitizes a page title for the text alternative (default: the `public` profile). */
  readonly sanitizeTitle?: (title: string, host: string) => string;
  /** Starts the screencast (default: {@link ScreencastSource.start}). */
  readonly startCapture?: (options: ScreencastSourceOptions) => Promise<LiveViewCapture>;
  /** Installs the focus guard (default: {@link installFocusGuard}). */
  readonly installGuard?: (
    page: PuppeteerPage,
    onFocus: (state: ProtectedFocusState) => void,
  ) => Promise<FocusGuardHandle>;
  /** Reads the task page's host and raw title (default: `page.url()` / `page.title()`). */
  readonly readPage?: (page: PuppeteerPage) => Promise<{ host: string; title: string }>;
}

interface ClientState {
  readonly sink: LiveViewSink;
  started: boolean;
  maxWidth: number;
  maxHeight: number;
  slot: { readonly meta: ScreencastFrameMeta; readonly jpeg: Uint8Array } | null;
  inFlight: number | null;
}

/** What the stream should be, as one comparable value. */
interface Desired {
  readonly page: TaskPage | null;
  /** At least one started client and a headless task page. */
  readonly wanted: boolean;
  readonly guard: boolean;
  readonly capture: boolean;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

const defaultSanitizeTitle = (title: string, host: string): string =>
  sanitize(title, 'public', host).text;

async function defaultReadPage(page: PuppeteerPage): Promise<{ host: string; title: string }> {
  let host: string;
  try {
    host = new URL(page.url()).hostname;
  } catch {
    host = '';
  }
  return { host, title: await page.title() };
}

export class LiveViewHub {
  private readonly clients = new Map<LiveViewClient, ClientState>();
  private readonly gate: FrameGate;
  private source: TaskPageSource | null = null;
  private unsubscribeSource: (() => void) | null = null;
  private unsubscribeProtection: (() => void) | null = null;
  private failure: {
    readonly reason: LiveViewStateReason;
    readonly code: LiveViewErrorCode;
  } | null = null;
  private page: LiveViewPage | null = null;
  private pageRead = 0;
  private lastStateKey: string | null = null;
  private readonly loggedCodes = new Set<string>();
  private readonly dropped: Record<FrameDropReason, number> = {
    protected: 0,
    stale_capture: 0,
    no_timestamp: 0,
  };

  // Actual stream, reconciled serially toward `desired()`.
  private guard: FocusGuardHandle | null = null;
  private guardPage: PuppeteerPage | null = null;
  private capture: LiveViewCapture | null = null;
  private capturePage: PuppeteerPage | null = null;
  private captureSize: { width: number; height: number } | null = null;
  private reconciling: Promise<void> = Promise.resolve();
  private reconcileQueued = false;
  private closed = false;

  public constructor(private readonly options: LiveViewHubOptions = {}) {
    this.gate = new FrameGate({ clock: options.clock ?? Date.now });
  }

  /** Clients currently connected. */
  public get clientCount(): number {
    return this.clients.size;
  }

  /** True while the screencast runs. */
  public get capturing(): boolean {
    return this.capture !== null;
  }

  /** True while the focus guard is installed. */
  public get guarding(): boolean {
    return this.guard !== null;
  }

  /** The current frame generation. */
  public get generation(): number {
    return this.gate.generation;
  }

  /** Frames the gate refused, by reason (for logs and tests). */
  public get droppedFrames(): Readonly<Record<FrameDropReason, number>> {
    return { ...this.dropped };
  }

  /** Settles once every queued start/stop has finished (for tests and shutdown). */
  public idle(): Promise<void> {
    return this.reconciling;
  }

  /**
   * Attaches the run's task page. Called once the orchestrator has one; a
   * later call replaces the previous source.
   */
  public attach(source: TaskPageSource): void {
    if (this.closed) return;
    this.detachSource();
    this.source = source;
    this.unsubscribeSource = source.subscribe((event) => this.onTaskPageEvent(event));
    this.unsubscribeProtection = source.screenProtection.subscribe((isProtected) => {
      this.onProtectionChanged(isProtected);
    });
    // The gate starts from the current protection, so an already-latched
    // screen is never streamed.
    this.applySignal(this.gate.onProtectionChanged(source.screenProtection.isProtectedNow));
    this.refreshPage();
    this.publishState();
    this.scheduleReconcile();
  }

  /** Adds a client; nothing is captured for it until it starts. */
  public addClient(sink: LiveViewSink): LiveViewClient {
    const state: ClientState = {
      sink,
      started: false,
      maxWidth: SCREENCAST_DEFAULTS.maxWidth,
      maxHeight: SCREENCAST_DEFAULTS.maxHeight,
      slot: null,
      inFlight: null,
    };
    const client: LiveViewClient = {
      start: (request = {}) => {
        if (!this.clients.has(client) || this.closed) return;
        state.started = true;
        state.maxWidth = request.max_width ?? SCREENCAST_DEFAULTS.maxWidth;
        state.maxHeight = request.max_height ?? SCREENCAST_DEFAULTS.maxHeight;
        this.sendControl(client, state, this.stateMessage());
        this.scheduleReconcile();
      },
      stop: () => {
        if (!state.started) return;
        state.started = false;
        state.slot = null;
        state.inFlight = null;
        this.scheduleReconcile();
      },
      ack: (ack) => {
        if (state.inFlight === null || ack.frame_seq < state.inFlight) return;
        state.inFlight = null;
        this.pump(client, state);
      },
      close: () => {
        if (!this.clients.delete(client)) return;
        state.started = false;
        state.slot = null;
        this.scheduleReconcile();
      },
    };
    this.clients.set(client, state);
    return client;
  }

  /** Stops everything and drops every client. Idempotent; never throws. */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clients.clear();
    this.detachSource();
    this.scheduleReconcile();
    await this.reconciling;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private onProtectionChanged(isProtected: boolean): void {
    const signal = this.gate.onProtectionChanged(isProtected);
    // Synchronous, before any await: slots emptied and `frames.cleared` sent
    // before the screencast is stopped and before any later frame.
    this.applySignal(signal);
    this.refreshPage();
    this.publishState();
    this.scheduleReconcile();
  }

  private onTaskPageEvent(event: TaskPageEvent): void {
    switch (event.kind) {
      case 'navigation_committed':
        this.applySignal(this.gate.onNavigationCommitted(event.epoch));
        // The latch clears on a new document, so evaluate it at the new epoch.
        this.source?.screenProtection.isProtected(event.epoch);
        break;
      case 'target_changed':
        this.applySignal(this.gate.onTargetChanged());
        break;
      case 'page_installed':
        break;
      case 'torn_down':
        this.page = null;
        break;
    }
    // A new document may capture again; a new page may also guard again.
    this.failure =
      event.kind === 'navigation_committed' && this.failure?.reason !== 'capture_failed'
        ? this.failure
        : null;
    this.refreshPage();
    this.publishState();
    this.scheduleReconcile();
  }

  private onFrame(frame: ScreencastFrame): void {
    const admission = this.gate.admit({
      capturedAtMs: frame.capturedAtMs,
      documentEpoch: this.source?.topLevelEpoch() ?? null,
      width: frame.width,
      height: frame.height,
    });
    if (admission.kind === 'drop') {
      this.dropped[admission.reason] += 1;
      return;
    }
    for (const [client, state] of this.clients) {
      if (!state.started) continue;
      state.slot = { meta: admission.meta, jpeg: frame.jpeg };
      this.pump(client, state);
    }
  }

  private applySignal(signal: FrameGateSignal | null): void {
    if (signal === null) return;
    for (const [client, state] of this.clients) {
      if (state.slot !== null && state.slot.meta.generation < signal.generation) state.slot = null;
      if (signal.kind === 'cleared' && state.started) {
        this.sendControl(client, state, {
          type: 'frames.cleared',
          generation: signal.generation,
          reason: 'protection',
        });
      }
    }
    if (signal.kind === 'cleared') this.page = null;
    this.options.logger?.debug(
      {
        generation: signal.generation,
        signal: signal.kind === 'cleared' ? 'cleared' : signal.cause,
      },
      'live view generation',
    );
  }

  // ---------------------------------------------------------------------------
  // Delivery
  // ---------------------------------------------------------------------------

  private pump(client: LiveViewClient, state: ClientState): void {
    if (!state.started || state.inFlight !== null || state.slot === null) return;
    const { meta, jpeg } = state.slot;
    state.slot = null;
    // Defense in depth: never hand out a frame from before the current generation.
    if (meta.generation < this.gate.generation || this.gate.isProtected) return;
    state.inFlight = meta.frame_seq;
    try {
      state.sink.frame(meta, jpeg);
    } catch (error) {
      this.dropClient(client, error);
    }
  }

  private sendControl(
    client: LiveViewClient,
    state: ClientState,
    message: LiveViewControlMessage,
  ): void {
    try {
      state.sink.control(message);
    } catch (error) {
      this.dropClient(client, error);
    }
  }

  private dropClient(client: LiveViewClient, error: unknown): void {
    this.logOnce('SINK_FAILED', { error: error instanceof Error ? error.name : 'unknown' });
    client.close();
  }

  private currentState(): {
    readonly state: LiveViewStreamState;
    readonly reason: LiveViewStateReason;
  } {
    const page = this.source?.current() ?? null;
    if (page === null) return { state: 'no_page', reason: 'none' };
    if (!page.headless) return { state: 'headed', reason: 'none' };
    if (this.failure !== null) return { state: 'unavailable', reason: this.failure.reason };
    if (this.gate.isProtected) return { state: 'protected', reason: 'none' };
    return { state: 'live', reason: 'none' };
  }

  private stateMessage(): LiveViewControlMessage {
    const { state, reason } = this.currentState();
    return {
      type: 'frames.state',
      generation: this.gate.generation,
      state,
      reason,
      page: state === 'protected' || state === 'no_page' ? null : this.page,
    };
  }

  /** Sends `frames.state` to started clients when anything about it changed. */
  private publishState(): void {
    const message = this.stateMessage();
    const key = JSON.stringify(message);
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    for (const [client, state] of this.clients) {
      if (state.started) this.sendControl(client, state, message);
    }
  }

  /** Reads host and title for the text alternative; never while protected. */
  private refreshPage(): void {
    const current = this.source?.current() ?? null;
    if (current === null || this.gate.isProtected) {
      this.page = null;
      return;
    }
    const read = ++this.pageRead;
    void (this.options.readPage ?? defaultReadPage)(current.page)
      .then(({ host, title }) => {
        if (read !== this.pageRead || this.gate.isProtected) return;
        const safeHost = host.slice(0, LIVE_VIEW_HOST_MAX_CHARS);
        const sanitized = (this.options.sanitizeTitle ?? defaultSanitizeTitle)(title, safeHost);
        this.page = { host: safeHost, title: sanitized.slice(0, LIVE_VIEW_TITLE_MAX_CHARS) };
        this.publishState();
      })
      .catch(() => {
        // The page navigated or closed mid-read; the next commit reads again.
        if (read === this.pageRead) this.page = null;
      });
  }

  // ---------------------------------------------------------------------------
  // Stream reconciliation (serial)
  // ---------------------------------------------------------------------------

  private desired(): Desired {
    const started = [...this.clients.values()].filter((state) => state.started);
    const page = this.closed ? null : (this.source?.current() ?? null);
    const wanted = started.length > 0 && page?.headless === true;
    return {
      page,
      wanted,
      // A guard that failed to install is not retried on this page: the
      // screen stays hidden (`unknown` focus) until the page changes.
      guard: wanted && this.failure?.reason !== 'protection_unverifiable',
      capture: wanted && !this.gate.isProtected && this.failure === null,
      maxWidth: Math.max(0, ...started.map((state) => state.maxWidth)),
      maxHeight: Math.max(0, ...started.map((state) => state.maxHeight)),
    };
  }

  private scheduleReconcile(): void {
    if (this.reconcileQueued) return;
    this.reconcileQueued = true;
    this.reconciling = this.reconciling.then(async () => {
      this.reconcileQueued = false;
      try {
        await this.reconcile();
      } catch (error) {
        this.fail('CAPTURE_FAILED', error);
      }
    });
  }

  private async reconcile(): Promise<void> {
    const want = this.desired();
    const wantPage = want.page?.page ?? null;

    if (
      this.capture !== null &&
      (!want.capture || this.capturePage !== wantPage || !this.sameSize(want))
    ) {
      await this.stopCapture();
    }
    if (this.guard !== null && (!want.guard || this.guardPage !== wantPage)) {
      await this.stopGuard();
    }
    if (want.guard && this.guard === null && wantPage !== null) {
      await this.startGuard(wantPage);
    }
    if (!want.wanted && this.guard === null) {
      // Nobody is watching: focus no longer protects anything, and a later
      // start retries whatever failed.
      this.source?.screenProtection.setFocus('clear');
      this.failure = null;
    }
    // Re-read: the guard install may have failed or protection may have started.
    const now = this.desired();
    if (now.capture && this.capture === null && wantPage !== null && now.page?.page === wantPage) {
      await this.startCapture(wantPage, now);
    }
    this.publishState();
    // Something changed while awaiting: go again.
    const after = this.desired();
    if (
      after.capture !== (this.capture !== null) ||
      after.guard !== (this.guard !== null) ||
      (this.capture !== null && this.capturePage !== (after.page?.page ?? null))
    ) {
      this.scheduleReconcile();
    }
  }

  private sameSize(want: Desired): boolean {
    return (
      this.captureSize !== null &&
      this.captureSize.width === want.maxWidth &&
      this.captureSize.height === want.maxHeight
    );
  }

  private async startGuard(page: PuppeteerPage): Promise<void> {
    const protection = this.source?.screenProtection;
    if (protection === undefined) return;
    try {
      this.guard = await (this.options.installGuard ?? installFocusGuard)(page, (state) => {
        protection.setFocus(state);
      });
      this.guardPage = page;
    } catch (error) {
      // The guard reported `unknown` already; the screen stays protected.
      this.fail('FOCUS_GUARD_UNAVAILABLE', error);
    }
  }

  private async stopGuard(): Promise<void> {
    const guard = this.guard;
    this.guard = null;
    this.guardPage = null;
    await guard?.dispose();
  }

  private async startCapture(page: PuppeteerPage, want: Desired): Promise<void> {
    this.applySignal(this.gate.onStreamRestarted());
    try {
      const capture = await (
        this.options.startCapture ?? ((options) => ScreencastSource.start(options))
      )({
        page,
        maxWidth: want.maxWidth,
        maxHeight: want.maxHeight,
        onFrame: (frame) => {
          this.onFrame(frame);
        },
        onError: (error) => {
          this.fail(error.code, error);
          this.scheduleReconcile();
        },
      });
      this.capture = capture;
      this.capturePage = page;
      this.captureSize = { width: want.maxWidth, height: want.maxHeight };
      this.options.logger?.debug(
        { generation: this.gate.generation, clients: this.clients.size },
        'live view capture started',
      );
    } catch (error) {
      this.fail('CAPTURE_FAILED', error);
    }
  }

  private async stopCapture(): Promise<void> {
    const capture = this.capture;
    this.capture = null;
    this.capturePage = null;
    this.captureSize = null;
    await capture?.stop();
    this.options.logger?.debug(
      { generation: this.gate.generation, dropped: { ...this.dropped } },
      'live view capture stopped',
    );
  }

  private fail(code: LiveViewErrorCode, error: unknown): void {
    this.failure = {
      code,
      reason: code === 'FOCUS_GUARD_UNAVAILABLE' ? 'protection_unverifiable' : 'capture_failed',
    };
    this.logOnce(code, {
      error:
        error instanceof LiveViewError
          ? error.code
          : error instanceof Error
            ? error.name
            : 'unknown',
    });
    this.publishState();
  }

  private logOnce(code: string, detail: Record<string, unknown>): void {
    if (this.loggedCodes.has(code)) return;
    this.loggedCodes.add(code);
    this.options.logger?.warn({ code, ...detail }, 'live view unavailable');
  }

  private detachSource(): void {
    this.unsubscribeSource?.();
    this.unsubscribeProtection?.();
    this.unsubscribeSource = null;
    this.unsubscribeProtection = null;
    this.source = null;
  }
}
