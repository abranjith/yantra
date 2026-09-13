/** Popup/new-tab ownership and cross-origin frame detection for recording. */

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
  /** Install the recorder only on this exact child target session. */
  onPopupSession(session: CDPSession, targetId: string): Promise<void>;
  /** Remove recording-owned listeners before the handler detaches its child session. */
  onPopupSessionClosed?(session: CDPSession, targetId: string): Promise<void> | void;
  onUnrecordedOrigin(origin: string): void;
}

export interface PopupHandlerOptions {
  readonly attachmentTimeoutMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface PendingAttachment {
  readonly targetId: string;
  readonly parentTargetId: string;
  readonly url: string;
  readonly wakeups: Set<() => void>;
  cancelledReason: string | null;
  promise: Promise<void> | null;
}

interface AttachmentSignal {
  readonly targetId: string;
  readonly sessionId: string;
}

const DEFAULT_ATTACHMENT_TIMEOUT_MS = 5_000;
const REGISTRY_POLL_MS = 20;

export class PopupHandler {
  private readonly popupChain = new Map<string, PopupEntry>();
  private readonly pendingTargets = new Map<string, PendingAttachment>();
  private readonly attachmentSignals = new Map<string, AttachmentSignal>();
  private readonly detachedSessionIds = new Set<string>();
  private readonly attachmentTimeoutMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<PopupHandlerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<PopupHandlerOptions['clearTimer']>;
  private mainFrameOrigin: string | null = null;
  private disposed = false;
  private installed = false;

  private readonly targetCreatedListener = (params: unknown): void => {
    const target = params as TargetCreatedParams;
    void this.onTargetCreated(target).catch((error: unknown) => {
      this.emitAttachmentFailure(target.targetInfo.targetId, error);
    });
  };

  private readonly targetDestroyedListener = (params: unknown): void => {
    void this.onTargetDestroyed(params as TargetDestroyedParams);
  };

  private readonly attachedListener = (params: unknown): void => {
    const attached = params as AttachedToTargetParams;
    this.attachmentSignals.set(attached.targetInfo.targetId, {
      targetId: attached.targetInfo.targetId,
      sessionId: attached.sessionId,
    });
    this.wakePending(attached.targetInfo.targetId);
  };

  private readonly detachedListener = (params: unknown): void => {
    const detached = params as DetachedFromTargetParams;
    if (detached.sessionId) this.detachedSessionIds.add(detached.sessionId);
    if (detached.targetId) this.wakePending(detached.targetId);
    else this.wakeAllPending();
  };

  constructor(
    private readonly browserCDP: CDPSession,
    private readonly mainTargetId: string,
    private readonly recordingId: string,
    private readonly callbacks: PopupHandlerCallbacks,
    options: PopupHandlerOptions = {},
  ) {
    this.attachmentTimeoutMs = options.attachmentTimeoutMs ?? DEFAULT_ATTACHMENT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  /** Register discovery listeners before enabling the Target domain. */
  async install(): Promise<void> {
    if (this.disposed || this.installed) return;
    this.installed = true;
    this.browserCDP.on('Target.targetCreated', this.targetCreatedListener);
    this.browserCDP.on('Target.targetDestroyed', this.targetDestroyedListener);
    this.browserCDP.on('Target.attachedToTarget', this.attachedListener);
    this.browserCDP.on('Target.detachedFromTarget', this.detachedListener);
    try {
      await this.browserCDP.send('Target.setDiscoverTargets', { discover: true });
    } catch (error) {
      this.removeDiscoveryListeners();
      this.installed = false;
      throw error;
    }
  }

  setMainFrameOrigin(url: string): void {
    try {
      this.mainFrameOrigin = new URL(url).origin;
    } catch {
      this.mainFrameOrigin = null;
    }
  }

  checkFrameOrigin(frameUrl: string, frameId: string): boolean {
    if (!this.mainFrameOrigin) return false;
    let frameOrigin: string;
    try {
      frameOrigin = new URL(frameUrl).origin;
    } catch {
      return false;
    }
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

  get popups(): ReadonlyMap<string, PopupEntry> {
    return this.popupChain;
  }

  /** Cancel in-flight work, remove exact listeners, and detach every owned child. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDiscoveryListeners();
    for (const pending of this.pendingTargets.values()) {
      pending.cancelledReason = 'handler disposed';
      this.wake(pending);
    }
    await Promise.allSettled(
      [...this.pendingTargets.values()].map((pending) => pending.promise ?? Promise.resolve()),
    );
    const entries = [...this.popupChain.values()];
    this.popupChain.clear();
    await Promise.allSettled(entries.map((entry) => this.releaseEntry(entry)));
  }

  private async onTargetCreated(params: TargetCreatedParams): Promise<void> {
    if (this.disposed) return;
    const { targetInfo } = params;
    if (targetInfo.type !== 'page') return;
    const parentTargetId = targetInfo.openerId ?? '';
    const belongsToRecording =
      parentTargetId === this.mainTargetId ||
      this.popupChain.has(parentTargetId) ||
      this.pendingTargets.has(parentTargetId);
    if (!belongsToRecording) return;
    if (this.popupChain.has(targetInfo.targetId) || this.pendingTargets.has(targetInfo.targetId)) {
      return;
    }

    const pending: PendingAttachment = {
      targetId: targetInfo.targetId,
      parentTargetId: parentTargetId || this.mainTargetId,
      url: targetInfo.url,
      wakeups: new Set(),
      cancelledReason: null,
      promise: null,
    };
    this.pendingTargets.set(pending.targetId, pending);
    pending.promise = this.attachPopup(pending);
    try {
      await pending.promise;
    } finally {
      if (this.pendingTargets.get(pending.targetId) === pending) {
        this.pendingTargets.delete(pending.targetId);
      }
    }
  }

  private async attachPopup(pending: PendingAttachment): Promise<void> {
    const response = await this.browserCDP.send('Target.attachToTarget', {
      targetId: pending.targetId,
      flatten: true,
    });
    const sessionId = response.sessionId;
    const childSession = await this.waitForPublicSession(pending, sessionId);
    if (pending.cancelledReason || this.disposed) {
      await this.detachSession(sessionId);
      throw new Error(pending.cancelledReason ?? 'handler disposed');
    }

    let entry: PopupEntry = {
      targetId: pending.targetId,
      parentTargetId: pending.parentTargetId,
      sessionId,
      cdpSession: childSession,
      url: pending.url,
      state: 'attaching',
    };
    this.popupChain.set(pending.targetId, entry);
    try {
      await this.callbacks.onPopupSession(childSession, pending.targetId);
      if (pending.cancelledReason || this.disposed || childSession.detached) {
        throw new Error(pending.cancelledReason ?? 'child session detached during instrumentation');
      }
      entry = { ...entry, state: 'ready' };
      this.popupChain.set(pending.targetId, entry);
      this.callbacks.onEvent({
        kind: 'popup_attached',
        recordingId: this.recordingId,
        targetId: pending.targetId,
        url: pending.url,
        ts: new Date().toISOString(),
      });
    } catch (error) {
      this.popupChain.delete(pending.targetId);
      await this.callbacks.onPopupSessionClosed?.(childSession, pending.targetId);
      await this.detachSession(sessionId);
      throw error;
    }
  }

  private async waitForPublicSession(
    pending: PendingAttachment,
    sessionId: string,
  ): Promise<CDPSession> {
    const deadline = this.now() + this.attachmentTimeoutMs;
    while (this.now() <= deadline) {
      if (pending.cancelledReason) throw new Error(pending.cancelledReason);
      if (this.disposed) throw new Error('handler disposed');
      if (this.browserCDP.detached || this.detachedSessionIds.has(sessionId)) {
        throw new Error('browser transport disconnected during popup attachment');
      }
      const signal = this.attachmentSignals.get(pending.targetId);
      if (signal && signal.sessionId !== sessionId) {
        throw new Error(
          `popup attachment identity mismatch for target ${pending.targetId}: expected session ${sessionId}`,
        );
      }
      const session = this.browserCDP.connection()?.session(sessionId) ?? null;
      if (session !== null) {
        if (session.id() !== sessionId) {
          throw new Error(
            `popup session registry returned the wrong session for ${pending.targetId}`,
          );
        }
        return session;
      }
      await this.waitForWakeup(pending, Math.min(REGISTRY_POLL_MS, deadline - this.now() + 1));
    }
    throw new Error(`popup attachment timed out for target ${pending.targetId}`);
  }

  private async onTargetDestroyed(params: TargetDestroyedParams): Promise<void> {
    const pending = this.pendingTargets.get(params.targetId);
    if (pending) {
      pending.cancelledReason = `target ${params.targetId} was destroyed during attachment`;
      this.wake(pending);
    }

    const entry = this.popupChain.get(params.targetId);
    if (!entry) return;
    this.popupChain.delete(params.targetId);
    await this.releaseEntry({ ...entry, state: 'detaching' });
    this.callbacks.onEvent({
      kind: 'popup_closed',
      recordingId: this.recordingId,
      targetId: params.targetId,
      ts: new Date().toISOString(),
    });
  }

  private async releaseEntry(entry: PopupEntry): Promise<void> {
    await this.callbacks.onPopupSessionClosed?.(entry.cdpSession, entry.targetId);
    await this.detachSession(entry.sessionId);
  }

  private async detachSession(sessionId: string): Promise<void> {
    if (this.detachedSessionIds.has(sessionId)) return;
    this.detachedSessionIds.add(sessionId);
    try {
      await this.browserCDP.send('Target.detachFromTarget', { sessionId });
    } catch {
      // Target destruction and transport shutdown make detach an expected no-op.
    }
  }

  private waitForWakeup(pending: PendingAttachment, delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = (): void => {
        this.clearTimer(timer);
        pending.wakeups.delete(wake);
        resolve();
      };
      const timer = this.setTimer(wake, Math.max(0, delayMs));
      pending.wakeups.add(wake);
    });
  }

  private wake(pending: PendingAttachment): void {
    for (const wake of [...pending.wakeups]) wake();
  }

  private wakePending(targetId: string): void {
    const pending = this.pendingTargets.get(targetId);
    if (pending) this.wake(pending);
  }

  private wakeAllPending(): void {
    for (const pending of this.pendingTargets.values()) this.wake(pending);
  }

  private removeDiscoveryListeners(): void {
    if (!this.installed) return;
    this.browserCDP.off('Target.targetCreated', this.targetCreatedListener);
    this.browserCDP.off('Target.targetDestroyed', this.targetDestroyedListener);
    this.browserCDP.off('Target.attachedToTarget', this.attachedListener);
    this.browserCDP.off('Target.detachedFromTarget', this.detachedListener);
  }

  private emitAttachmentFailure(targetId: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.callbacks.onEvent({
      kind: 'recording_degraded',
      recordingId: this.recordingId,
      reason: `popup ${targetId} unavailable: ${reason}`,
      ts: new Date().toISOString(),
    });
  }
}

interface TargetCreatedParams {
  readonly targetInfo: {
    readonly targetId: string;
    readonly type: string;
    readonly url: string;
    readonly openerId?: string;
  };
}

interface TargetDestroyedParams {
  readonly targetId: string;
}

interface AttachedToTargetParams {
  readonly sessionId: string;
  readonly targetInfo: { readonly targetId: string };
}

interface DetachedFromTargetParams {
  readonly sessionId?: string;
  readonly targetId?: string;
}
