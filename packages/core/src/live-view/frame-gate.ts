/**
 * Frame generations and fresh-capture admission (FEAT-069 TASK-005, plan §12).
 *
 * A pure state machine with an injected clock; it holds no bytes. The worker
 * increments the generation on every event that can make an already-captured
 * frame wrong to show:
 *
 * - protection set **or** cleared;
 * - a top-level navigation commit;
 * - a task-page target change (popup adoption);
 * - a screencast stream restart.
 *
 * Each increment stamps `generationStartedAt = clock()`. A frame is forwarded
 * only when the screen is not protected, its capture timestamp is known, and
 * it was captured after the current generation began (one clock tick later, at
 * least: see {@link GENERATION_CLOCK_TICK_MS}). So a frame that
 * was in flight when protection started is dropped, and after protection
 * clears only a capture taken after the new generation began is shown.
 *
 * The clock must share the capture timestamps' timebase: CDP reports
 * `metadata.timestamp` as wall-clock seconds, so the hub passes `Date.now`.
 */

import type { ScreencastFrameMeta } from '@yantra/protocol';

/**
 * The gate clock's resolution. `Date.now()` floors to the millisecond while
 * CDP capture times are fractional, so a capture inside the same tick as a
 * generation change cannot be proven to come after it; it is treated as stale.
 */
export const GENERATION_CLOCK_TICK_MS = 1;

/** Why the gate dropped a frame. Closed, for tests and debug logs. */
export type FrameDropReason =
  /** The screen is protected. */
  | 'protected'
  /** Captured before the current generation began. */
  | 'stale_capture'
  /** The capture time is unknown, so freshness cannot be proven. */
  | 'no_timestamp';

/** What changed the generation, for `frames.state`. */
export type GenerationCause =
  'protection_cleared' | 'navigation' | 'target_changed' | 'stream_restarted';

/** What the hub must tell clients after a generation change. */
export type FrameGateSignal =
  /** Protection began: every client discards its image now (`frames.cleared`). */
  | { readonly kind: 'cleared'; readonly generation: number }
  /** Any other change (`frames.state` carries the new generation). */
  | { readonly kind: 'state'; readonly generation: number; readonly cause: GenerationCause };

/** One frame as the source saw it. */
export interface FrameCandidate {
  /** Capture instant in ms on the gate clock's timebase; null when unreadable. */
  readonly capturedAtMs: number | null;
  /** The task page's top-level epoch when the frame arrived; null when unreadable. */
  readonly documentEpoch: number | null;
  readonly width: number;
  readonly height: number;
}

export type FrameAdmission =
  | { readonly kind: 'forward'; readonly meta: ScreencastFrameMeta }
  | { readonly kind: 'drop'; readonly reason: FrameDropReason };

export interface FrameGateOptions {
  /** Milliseconds; same timebase as {@link FrameCandidate.capturedAtMs}. */
  readonly clock: () => number;
  /** Whether the screen is already protected when the stream begins. */
  readonly initiallyProtected?: boolean;
}

export class FrameGate {
  private currentGeneration = 0;
  private startedAt: number;
  private protectedNow: boolean;
  private lastEpoch: number | null = null;
  private nextFrameSeq = 0;
  private readonly clock: () => number;

  public constructor(options: FrameGateOptions) {
    this.clock = options.clock;
    this.startedAt = this.clock();
    this.protectedNow = options.initiallyProtected ?? false;
  }

  /** The current generation; never decreases. */
  public get generation(): number {
    return this.currentGeneration;
  }

  /** When the current generation began, on the gate clock. */
  public get generationStartedAt(): number {
    return this.startedAt;
  }

  public get isProtected(): boolean {
    return this.protectedNow;
  }

  /** The epoch of the last navigation commit seen, if any. */
  public get documentEpoch(): number | null {
    return this.lastEpoch;
  }

  /**
   * Protection set or cleared. Returns null when nothing changed (setting
   * protection twice emits one `cleared`).
   */
  public onProtectionChanged(isProtected: boolean): FrameGateSignal | null {
    if (isProtected === this.protectedNow) return null;
    this.protectedNow = isProtected;
    const generation = this.bump();
    return isProtected
      ? { kind: 'cleared', generation }
      : { kind: 'state', generation, cause: 'protection_cleared' };
  }

  /** A top-level navigation committed on the task page. */
  public onNavigationCommitted(epoch: number | null): FrameGateSignal {
    this.lastEpoch = epoch;
    return { kind: 'state', generation: this.bump(), cause: 'navigation' };
  }

  /** The task page changed (popup adoption). */
  public onTargetChanged(): FrameGateSignal {
    this.lastEpoch = null;
    return { kind: 'state', generation: this.bump(), cause: 'target_changed' };
  }

  /** The screencast stream was (re)started. */
  public onStreamRestarted(): FrameGateSignal {
    return { kind: 'state', generation: this.bump(), cause: 'stream_restarted' };
  }

  /** Decides whether one captured frame may be shown, and stamps it if so. */
  public admit(frame: FrameCandidate): FrameAdmission {
    if (this.protectedNow) return { kind: 'drop', reason: 'protected' };
    if (frame.capturedAtMs === null || !Number.isFinite(frame.capturedAtMs)) {
      return { kind: 'drop', reason: 'no_timestamp' };
    }
    if (frame.capturedAtMs < this.startedAt + GENERATION_CLOCK_TICK_MS) {
      return { kind: 'drop', reason: 'stale_capture' };
    }
    const meta: ScreencastFrameMeta = {
      generation: this.currentGeneration,
      frame_seq: this.nextFrameSeq,
      document_epoch: frame.documentEpoch ?? this.lastEpoch,
      captured_at: new Date(frame.capturedAtMs).toISOString(),
      width: frame.width,
      height: frame.height,
    };
    this.nextFrameSeq += 1;
    return { kind: 'forward', meta };
  }

  private bump(): number {
    this.currentGeneration += 1;
    // Never earlier than the previous start, even if the clock steps back.
    this.startedAt = Math.max(this.startedAt, this.clock());
    return this.currentGeneration;
  }
}
