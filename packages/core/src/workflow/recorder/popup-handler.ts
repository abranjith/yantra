/**
 * Popup / new-tab handler (TASK-006) and cross-origin iframe detector (TASK-006a).
 *
 * Subscribes to `Target.targetCreated` / `Target.targetDestroyed` on the browser-level
 * CDP session. For each new popup target: attaches, re-injects the overlay, tracks
 * parentage, and emits events.
 *
 * Cross-origin iframes: detects via `Page.frameNavigated` origin comparison.
 * Emits `UnrecordedFrameEvent` and adds the origin to `unrecordedFrameOrigins`.
 */

import type { CDPSession } from 'puppeteer-core';

import type {
  PopupAttachedEvent,
  PopupClosedEvent,
  PopupEntry,
  RecordingDegradedEvent,
  UnrecordedFrameEvent,
} from './types.js';

export type PopupHandlerEvent =
  | PopupAttachedEvent
  | PopupClosedEvent
  | UnrecordedFrameEvent
  | RecordingDegradedEvent;

export interface PopupHandlerCallbacks {
  onEvent(event: PopupHandlerEvent): void;
  /** Called when a new popup CDPSession is ready — install overlay + binding on it. */
  onPopupSession(session: CDPSession, targetId: string): Promise<void>;
  /** Called when a cross-origin origin is detected (deduplication is caller's responsibility). */
  onUnrecordedOrigin(origin: string): void;
}

/**
 * Manages popup lifecycle and cross-origin iframe detection.
 *
 * @example
 * const handler = new PopupHandler(browserCDP, mainTargetId, callbacks);
 * await handler.install();
 * // Later:
 * handler.dispose();
 */
export class PopupHandler {
  private readonly browserCDP: CDPSession;
  private readonly mainTargetId: string;
  private readonly recordingId: string;
  private readonly callbacks: PopupHandlerCallbacks;
  private readonly popupChain = new Map<string, PopupEntry>();
  private mainFrameOrigin: string | null = null;
  private disposed = false;

  constructor(
    browserCDP: CDPSession,
    mainTargetId: string,
    recordingId: string,
    callbacks: PopupHandlerCallbacks,
  ) {
    this.browserCDP = browserCDP;
    this.mainTargetId = mainTargetId;
    this.recordingId = recordingId;
    this.callbacks = callbacks;
  }

  /**
   * Install CDP subscriptions.
   * Must be called after the browser CDP session is ready.
   */
  async install(): Promise<void> {
    if (this.disposed) return;

    // Enable Target domain for popup discovery
    await this.browserCDP.send('Target.setDiscoverTargets', { discover: true });

    this.browserCDP.on('Target.targetCreated', (params: unknown) => {
      void this.onTargetCreated(params as TargetCreatedParams).catch((err: unknown) => {
        this.callbacks.onEvent({
          kind: 'recording_degraded',
          recordingId: this.recordingId,
          reason: `popup attach failed: ${String(err)}`,
          ts: new Date().toISOString(),
        });
      });
    });

    this.browserCDP.on('Target.targetDestroyed', (params: unknown) => {
      this.onTargetDestroyed(params as TargetDestroyedParams);
    });
  }

  /**
   * Track the main frame's origin for cross-origin comparison.
   * Call this whenever the main frame navigates.
   */
  setMainFrameOrigin(url: string): void {
    try {
      this.mainFrameOrigin = new URL(url).origin;
    } catch {
      this.mainFrameOrigin = null;
    }
  }

  /**
   * Check a frame's URL against the main frame's origin.
   * Emits `UnrecordedFrameEvent` for cross-origin frames (once per origin).
   *
   * @param frameUrl - The navigated frame's URL
   * @param frameId - CDP frame ID for the event
   * @returns true if the frame is cross-origin (not instrumented)
   */
  checkFrameOrigin(frameUrl: string, frameId: string): boolean {
    if (!this.mainFrameOrigin) return false;
    let frameOrigin: string;
    try {
      frameOrigin = new URL(frameUrl).origin;
    } catch {
      return false;
    }

    // Same origin or data/about frames — instrumented
    if (frameOrigin === this.mainFrameOrigin || frameOrigin === 'null') return false;

    this.callbacks.onUnrecordedOrigin(frameOrigin);
    this.callbacks.onEvent({
      kind: 'unrecorded_frame',
      recordingId: this.recordingId,
      origin: frameOrigin,
      frameId,
      detectedAt: new Date().toISOString(),
    });

    return true;
  }

  /** Returns the current map of attached popup targets. */
  get popups(): ReadonlyMap<string, PopupEntry> {
    return this.popupChain;
  }

  dispose(): void {
    this.disposed = true;
    // CDP session cleanup is handled by the caller (RecordingSession.stop)
  }

  // ---------------------------------------------------------------------------
  // Private CDP handlers
  // ---------------------------------------------------------------------------

  private async onTargetCreated(params: TargetCreatedParams): Promise<void> {
    if (this.disposed) return;

    const { targetInfo } = params;
    if (targetInfo.type !== 'page') return;

    // Only handle popups opened from our main target or from a known popup
    const isOurPopup =
      targetInfo.openerId === this.mainTargetId ||
      this.popupChain.has(targetInfo.openerId ?? '');

    if (!isOurPopup) return;

    // Attach to the new target
    const { sessionId } = await this.browserCDP.send('Target.attachToTarget', {
      targetId: targetInfo.targetId,
      flatten: true,
    }) as { sessionId: string };

    // Create a CDPSession for this target
    // puppeteer-core's Connection exposes session creation via the browser's target
    // For raw CDP sessions, we use the sessionId from the attachment
    const popupSession = await this.createSessionFromId(sessionId);

    const entry: PopupEntry = {
      targetId: targetInfo.targetId,
      parentTargetId: targetInfo.openerId ?? this.mainTargetId,
      cdpSession: popupSession,
      url: targetInfo.url,
    };

    this.popupChain.set(targetInfo.targetId, entry);

    // Install overlay + binding on the popup's session
    await this.callbacks.onPopupSession(popupSession, targetInfo.targetId);

    this.callbacks.onEvent({
      kind: 'popup_attached',
      recordingId: this.recordingId,
      targetId: targetInfo.targetId,
      url: targetInfo.url,
      ts: new Date().toISOString(),
    });
  }

  private onTargetDestroyed(params: TargetDestroyedParams): void {
    const { targetId } = params;
    if (!this.popupChain.has(targetId)) return;

    this.popupChain.delete(targetId);

    this.callbacks.onEvent({
      kind: 'popup_closed',
      recordingId: this.recordingId,
      targetId,
      ts: new Date().toISOString(),
    });
  }

  /**
   * Create a puppeteer CDPSession from a raw sessionId.
   * In puppeteer-core v24+ the browser's connection exposes the session registry.
   */
  private async createSessionFromId(sessionId: string): Promise<CDPSession> {
    // Access the internal connection to get the session
    // This uses puppeteer-core's internal _connection property
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (this.browserCDP as any)._connection ?? (this.browserCDP as any).connection;
    if (conn && typeof conn.session === 'function') {
      const session = conn.session(sessionId) as CDPSession | null;
      if (session) return session;
    }
    // Fallback: the browserCDP itself is the session for flat CDP connections
    // (pipe transport) — return it as a shared session
    return this.browserCDP;
  }
}

// ---------------------------------------------------------------------------
// CDP event param shapes
// ---------------------------------------------------------------------------

interface TargetCreatedParams {
  targetInfo: {
    targetId: string;
    type: string;
    url: string;
    openerId?: string;
  };
}

interface TargetDestroyedParams {
  targetId: string;
}
