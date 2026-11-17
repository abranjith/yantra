/**
 * The live view of one run in one window (FEAT-069 TASK-010).
 *
 * A `useSyncExternalStore` store, one per run view (no singleton):
 *
 * - subscribes with `frames.subscribe {run_id}` and follows `frames.state`
 *   and `frames.cleared`;
 * - decodes binary frame payloads, decodes the JPEG off the main path
 *   (`createImageBitmap` by default), and **re-checks the generation floor at
 *   draw time**, so a decode that finishes after `frames.cleared` is closed
 *   and never drawn;
 * - on `frames.cleared` clears the canvas and switches to `protected`
 *   synchronously, before any later work;
 * - acks every frame after it is drawn or dropped;
 * - on a lost connection discards the image and shows `reconnecting`; after
 *   reconnecting it subscribes again and waits for a fresh frame.
 *
 * Frames are never stored beyond the one being drawn, and never persisted.
 */

import {
  FramesCleared,
  FramesState as FramesStateSchema,
  FramePayloadError,
  decodeFramePayload,
  type FramesState,
  type LiveViewPage,
} from '@yantra/protocol/screencast';
import type { BrowserViewportReason, BrowserViewportState } from '@yantra/ui';

import type { AppRpc } from '../host/app-rpc.js';
import type { ConnectionState } from '../host/connection-store.js';

/** A decoded image the canvas can draw. */
export interface DrawableImage {
  readonly width: number;
  readonly height: number;
  close(): void;
}

/** What the store needs from a canvas (a real one, or a test double). */
export interface LiveViewCanvas {
  width: number;
  height: number;
  getContext(kind: '2d'): {
    clearRect(x: number, y: number, w: number, h: number): void;
    drawImage(image: never, x: number, y: number): void;
  } | null;
}

export interface LiveViewSnapshot {
  readonly state: BrowserViewportState;
  readonly reason: BrowserViewportReason;
  readonly page: LiveViewPage | null;
  /** The highest generation announced by `frames.cleared` or `frames.state`. */
  readonly generationFloor: number;
}

/** The last frame drawn; per-frame, so it never notifies React subscribers. */
export interface LiveViewDrawn {
  readonly generation: number;
  readonly frame_seq: number;
}

/** Per-frame measurements for the budget monitor (TASK-011). */
export interface LiveViewFrameSample {
  /** `offered`: a frame arrived; `drawn`: it reached the canvas. */
  readonly kind: 'offered' | 'drawn';
  /** Main-thread time spent on it in the store's handlers, ms. */
  readonly busyMs: number;
}

export interface LiveViewConnection {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ConnectionState;
}

export interface LiveViewStoreDeps {
  readonly rpc: AppRpc;
  readonly runId: string;
  readonly connection?: LiveViewConnection;
  /** Decodes JPEG bytes (default `createImageBitmap`). */
  readonly decodeImage?: (jpeg: Uint8Array) => Promise<DrawableImage>;
  /** Monotonic ms for handler timing (default `performance.now`). */
  readonly now?: () => number;
  readonly onSample?: (sample: LiveViewFrameSample) => void;
  /** Timer seam for subscribe retries (default `setTimeout`). */
  readonly schedule?: (run: () => void, ms: number) => void;
}

/**
 * How often, and how many times, a refused `frames.subscribe` is retried. The
 * cockpit subscribes as it mounts, while the host may still be attaching the
 * run's worker (`run.subscribe` is in flight), and the host refuses a run it
 * has not attached yet.
 */
export const SUBSCRIBE_RETRY_MS = 500;
export const SUBSCRIBE_RETRIES = 10;

const defaultDecode = (jpeg: Uint8Array): Promise<DrawableImage> =>
  createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' }));

export class LiveViewStore {
  private snapshot: LiveViewSnapshot = {
    state: 'connecting',
    reason: 'none',
    page: null,
    generationFloor: 0,
  };
  /**
   * Kept out of the snapshot on purpose: a snapshot change re-renders every
   * subscriber, and a per-frame change re-rendered the whole cockpit 10 times
   * a second (measured in a real app window: about 15% of one core).
   */
  private drawn: LiveViewDrawn | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly dispose: (() => void)[] = [];
  private canvas: LiveViewCanvas | null = null;
  private started = false;
  private wasConnected = true;
  /** Bumped by every subscribe, so an old subscribe's late answer is ignored. */
  private subscription = 0;
  private readonly now: () => number;

  public constructor(private readonly deps: LiveViewStoreDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  public readonly getSnapshot = (): LiveViewSnapshot => this.snapshot;

  /** The last frame drawn, or null after a clear (for diagnostics and tests). */
  public get lastDrawn(): LiveViewDrawn | null {
    return this.drawn;
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The BrowserViewport's `draw`: the canvas to paint into, or null. */
  public readonly attachCanvas = (canvas: LiveViewCanvas | null): void => {
    this.canvas = canvas;
    if (this.snapshot.state !== 'live') this.clearCanvas();
  };

  /** Starts watching. Idempotent. */
  public start(): void {
    if (this.started) return;
    this.started = true;
    const { rpc } = this.deps;
    this.dispose.push(
      rpc.on('frames.cleared', (params) => {
        this.onCleared(params);
      }),
      rpc.on('frames.state', (params) => {
        this.onState(params);
      }),
    );
    const offBinary = rpc.onBinary?.((bytes) => {
      void this.onFrame(new Uint8Array(bytes));
    });
    if (offBinary !== undefined) this.dispose.push(offBinary);
    const connection = this.deps.connection;
    if (connection !== undefined) {
      this.wasConnected = connection.getSnapshot().status === 'connected';
      this.dispose.push(
        connection.subscribe(() => {
          this.onConnection(connection.getSnapshot());
        }),
      );
    }
    this.subscribeToFrames();
  }

  /** Stops watching and tells the host. Idempotent. */
  public stop(): void {
    if (!this.started) return;
    this.started = false;
    this.subscription += 1;
    for (const off of this.dispose.splice(0)) off();
    this.clearCanvas();
    void this.deps.rpc
      .request('frames.unsubscribe', { run_id: this.deps.runId })
      .catch(() => undefined);
  }

  // ---------------------------------------------------------------------------

  private subscribeToFrames(attempt = 0): void {
    const ticket = ++this.subscription;
    this.deps.rpc
      .request<FramesState>('frames.subscribe', { run_id: this.deps.runId })
      .then((result) => {
        if (ticket !== this.subscription) return;
        const parsed = FramesStateSchema.safeParse(result);
        if (parsed.success) this.applyState(parsed.data);
      })
      .catch(() => {
        if (ticket !== this.subscription) return;
        if (attempt < SUBSCRIBE_RETRIES) {
          (this.deps.schedule ?? ((run, ms) => void setTimeout(run, ms)))(() => {
            if (this.started && ticket === this.subscription) this.subscribeToFrames(attempt + 1);
          }, SUBSCRIBE_RETRY_MS);
          return;
        }
        this.set({ state: 'unavailable', reason: 'none', page: null });
      });
  }

  private onConnection(connection: ConnectionState): void {
    const connected = connection.status === 'connected';
    if (!connected && this.wasConnected) {
      // The image may be stale by the time the socket returns: drop it now.
      this.clearCanvas();
      this.drawn = null;
      this.set({ state: 'reconnecting', page: null });
    } else if (connected && !this.wasConnected && this.started) {
      this.subscribeToFrames();
    }
    this.wasConnected = connected;
  }

  private onCleared(params: Record<string, unknown>): void {
    if (params.run_id !== this.deps.runId) return;
    const { run_id: _run, ...body } = params;
    const parsed = FramesCleared.safeParse(body);
    if (!parsed.success) return;
    // Synchronous, before any later work: wipe the pixels, then say why.
    this.clearCanvas();
    this.set({
      state: 'protected',
      reason: 'none',
      page: null,
      generationFloor: Math.max(this.snapshot.generationFloor, parsed.data.generation),
    });
    this.drawn = null;
  }

  private onState(params: Record<string, unknown>): void {
    if (params.run_id !== this.deps.runId) return;
    const { run_id: _run, ...body } = params;
    const parsed = FramesStateSchema.safeParse(body);
    if (parsed.success) this.applyState(parsed.data);
  }

  private applyState(state: FramesState): void {
    if (state.state !== 'live') this.clearCanvas();
    this.set({
      state: state.state,
      reason: state.reason,
      page: state.page,
      generationFloor: Math.max(this.snapshot.generationFloor, state.generation),
    });
  }

  private async onFrame(bytes: Uint8Array): Promise<void> {
    const started = this.now();
    const decoded = decodeFramePayload(bytes);
    // Unreadable, so it cannot be acked; the host encodes every payload itself,
    // so this is a host defect, and the view stalls visibly rather than guess.
    if (decoded instanceof FramePayloadError) return;
    const { meta, jpeg } = decoded;
    const ack = (): void => {
      void this.deps.rpc
        .request('frames.ack', {
          run_id: this.deps.runId,
          generation: meta.generation,
          frame_seq: meta.frame_seq,
        })
        .catch(() => undefined);
    };
    this.deps.onSample?.({ kind: 'offered', busyMs: this.now() - started });
    if (!this.drawable(meta.generation)) {
      ack();
      return;
    }
    let image: DrawableImage;
    try {
      image = await (this.deps.decodeImage ?? defaultDecode)(jpeg);
    } catch {
      ack();
      return;
    }
    const drawStarted = this.now();
    // The floor may have risen while the image decoded: check again now.
    if (!this.drawable(meta.generation) || this.canvas === null) {
      image.close();
      ack();
      return;
    }
    const canvas = this.canvas;
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    canvas.getContext('2d')?.drawImage(image as never, 0, 0);
    image.close();
    this.drawn = { generation: meta.generation, frame_seq: meta.frame_seq };
    this.deps.onSample?.({ kind: 'drawn', busyMs: this.now() - drawStarted });
    ack();
  }

  private drawable(generation: number): boolean {
    return (
      this.started && this.snapshot.state === 'live' && generation >= this.snapshot.generationFloor
    );
  }

  private clearCanvas(): void {
    const canvas = this.canvas;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private set(next: Partial<LiveViewSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of [...this.listeners]) listener();
  }
}
