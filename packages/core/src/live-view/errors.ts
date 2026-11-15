/**
 * Why the live view failed (FEAT-069). A closed set: each maps to
 * `frames.state unavailable` with a reason, and none changes a run's outcome.
 */
export type LiveViewErrorCode =
  /** The CDP screencast could not start or stopped unexpectedly. */
  | 'CAPTURE_FAILED'
  /** The protected-focus guard could not be installed; frames stay hidden. */
  | 'FOCUS_GUARD_UNAVAILABLE'
  /** A frame payload could not be encoded or decoded; it was dropped. */
  | 'PAYLOAD_INVALID';

/** A live-view failure. `message` names what failed and never carries page data. */
export class LiveViewError extends Error {
  public override readonly name = 'LiveViewError';

  public constructor(
    public readonly code: LiveViewErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}
