// @no-llm
import { ScreencastFrameMeta } from '@yantra/protocol';
import { describe, expect, it } from 'vitest';

import {
  FrameGate,
  GENERATION_CLOCK_TICK_MS,
  type FrameAdmission,
} from '../../src/live-view/frame-gate.js';

/** A stepped clock: time moves only when a test says so (memory: never the wall clock). */
function steppedClock(start = 1_000_000): { now: () => number; advance: (ms: number) => number } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => (current += ms),
  };
}

const frameAt = (capturedAtMs: number | null, documentEpoch: number | null = 1) => ({
  capturedAtMs,
  documentEpoch,
  width: 1280,
  height: 800,
});

function forwarded(admission: FrameAdmission) {
  if (admission.kind !== 'forward') throw new Error(`dropped: ${admission.reason}`);
  return admission.meta;
}

describe('@no-llm FrameGate', () => {
  it('forwards a fresh frame at generation 0 with schema-valid meta', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const meta = forwarded(gate.admit(frameAt(clock.advance(50))));
    expect(meta).toMatchObject({ generation: 0, frame_seq: 0, document_epoch: 1, width: 1280 });
    expect(ScreencastFrameMeta.safeParse(meta).success).toBe(true);
    expect(meta.captured_at).toBe(new Date(clock.now()).toISOString());
  });

  it('drops a frame captured before protection started but admitted after it', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const capturedBefore = clock.advance(10);
    clock.advance(10);
    expect(gate.onProtectionChanged(true)).toEqual({ kind: 'cleared', generation: 1 });
    expect(gate.admit(frameAt(capturedBefore))).toEqual({ kind: 'drop', reason: 'protected' });
  });

  it('drops every frame while protected, fresh or not', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now, initiallyProtected: true });
    expect(gate.admit(frameAt(clock.advance(100)))).toEqual({ kind: 'drop', reason: 'protected' });
  });

  it('after protection clears, drops a capture taken before the clear and forwards the first later one', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    clock.advance(10);
    gate.onProtectionChanged(true);
    const capturedWhileProtected = clock.advance(10);
    clock.advance(10);
    expect(gate.onProtectionChanged(false)).toEqual({
      kind: 'state',
      generation: 2,
      cause: 'protection_cleared',
    });
    expect(gate.admit(frameAt(capturedWhileProtected))).toEqual({
      kind: 'drop',
      reason: 'stale_capture',
    });
    const fresh = forwarded(gate.admit(frameAt(clock.advance(5))));
    expect(fresh.generation).toBe(2);
  });

  it('treats a capture in the same clock tick as the change as stale', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    clock.advance(10);
    gate.onProtectionChanged(true);
    gate.onProtectionChanged(false);
    const changedAt = gate.generationStartedAt;
    expect(gate.admit(frameAt(changedAt))).toEqual({ kind: 'drop', reason: 'stale_capture' });
    expect(gate.admit(frameAt(changedAt + 0.5))).toEqual({ kind: 'drop', reason: 'stale_capture' });
    expect(gate.admit(frameAt(changedAt + GENERATION_CLOCK_TICK_MS)).kind).toBe('forward');
  });

  it('bumps the generation on navigation and voids older captures', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const old = clock.advance(10);
    clock.advance(10);
    expect(gate.onNavigationCommitted(7)).toEqual({
      kind: 'state',
      generation: 1,
      cause: 'navigation',
    });
    expect(gate.documentEpoch).toBe(7);
    expect(gate.admit(frameAt(old))).toEqual({ kind: 'drop', reason: 'stale_capture' });
    const meta = forwarded(gate.admit(frameAt(clock.advance(10), null)));
    expect(meta).toMatchObject({ generation: 1, document_epoch: 7 });
  });

  it('bumps the generation on a target change and forgets the old epoch', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    gate.onNavigationCommitted(3);
    const old = clock.advance(10);
    clock.advance(10);
    expect(gate.onTargetChanged()).toEqual({
      kind: 'state',
      generation: 2,
      cause: 'target_changed',
    });
    expect(gate.documentEpoch).toBeNull();
    expect(gate.admit(frameAt(old))).toEqual({ kind: 'drop', reason: 'stale_capture' });
    expect(forwarded(gate.admit(frameAt(clock.advance(10), null))).document_epoch).toBeNull();
  });

  it('bumps the generation on a stream restart', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const old = clock.advance(10);
    clock.advance(1);
    expect(gate.onStreamRestarted()).toEqual({
      kind: 'state',
      generation: 1,
      cause: 'stream_restarted',
    });
    expect(gate.admit(frameAt(old)).kind).toBe('drop');
  });

  it('never decreases the generation, even when the clock steps back', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const seen: number[] = [gate.generation];
    for (const step of [5, -50, 5, -1000, 20]) {
      clock.advance(step);
      gate.onNavigationCommitted(null);
      gate.onProtectionChanged(true);
      gate.onProtectionChanged(false);
      gate.onTargetChanged();
      seen.push(gate.generation);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
    // The start instant never moves backwards either, so a stepped-back clock cannot readmit old frames.
    const before = gate.generationStartedAt;
    clock.advance(-10_000);
    gate.onStreamRestarted();
    expect(gate.generationStartedAt).toBeGreaterThanOrEqual(before);
  });

  it('emits one cleared for protection set twice, and nothing for a repeated clear', () => {
    const gate = new FrameGate({ clock: steppedClock().now });
    expect(gate.onProtectionChanged(true)).toEqual({ kind: 'cleared', generation: 1 });
    expect(gate.onProtectionChanged(true)).toBeNull();
    expect(gate.generation).toBe(1);
    expect(gate.onProtectionChanged(false)?.kind).toBe('state');
    expect(gate.onProtectionChanged(false)).toBeNull();
    expect(gate.generation).toBe(2);
  });

  it('starting protected emits nothing until it clears', () => {
    const gate = new FrameGate({ clock: steppedClock().now, initiallyProtected: true });
    expect(gate.isProtected).toBe(true);
    expect(gate.onProtectionChanged(true)).toBeNull();
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY])(
    'drops a frame with timestamp %s',
    (stamp) => {
      const gate = new FrameGate({ clock: steppedClock().now });
      expect(gate.admit(frameAt(stamp))).toEqual({ kind: 'drop', reason: 'no_timestamp' });
    },
  );

  it('numbers forwarded frames gap-free and skips dropped ones', () => {
    const clock = steppedClock();
    const gate = new FrameGate({ clock: clock.now });
    const sequence: number[] = [];
    const take = (admission: FrameAdmission) => {
      if (admission.kind === 'forward') sequence.push(admission.meta.frame_seq);
    };
    take(gate.admit(frameAt(clock.advance(10))));
    take(gate.admit(frameAt(null)));
    const stale = clock.advance(10);
    clock.advance(10);
    gate.onNavigationCommitted(2);
    take(gate.admit(frameAt(stale)));
    take(gate.admit(frameAt(clock.advance(10))));
    gate.onProtectionChanged(true);
    take(gate.admit(frameAt(clock.advance(10))));
    gate.onProtectionChanged(false);
    take(gate.admit(frameAt(clock.advance(10))));
    expect(sequence).toEqual([0, 1, 2]);
  });
});
