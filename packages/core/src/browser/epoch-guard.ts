/**
 * The top-level-document epoch guard shared by every screenshot path
 * (FEAT-058, extracted from `set-of-marks.ts`).
 *
 * A capture is valid only if the top-level page stayed on one committed
 * document from before the first pixel until after the last one. Vision
 * Assist's set-of-marks capture and the clean deliverable capture both read
 * the epoch through this module, so the two can never disagree about what
 * "the page changed" means.
 */

/** A screenshot stage failed: the document changed, or the marks overlay stayed behind. */
export class SetOfMarksError extends Error {
  public constructor(
    public readonly code: 'SET_OF_MARKS_EPOCH_CHANGED' | 'SET_OF_MARKS_REMOVAL_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SetOfMarksError';
  }
}

/** Inputs to one epoch-guarded capture. */
export interface EpochGuardedCaptureOptions<T> {
  /** The current top-level committed-document epoch, or null when unreadable. */
  readonly readTopLevelEpoch: () => number | null;
  /** Takes the capture; every pixel it returns must come from one document. */
  readonly capture: () => Promise<T>;
}

/**
 * Reads the epoch a capture starts from.
 *
 * @throws SetOfMarksError when the epoch cannot be read, so a capture never
 *   starts on a document it cannot identify.
 */
export function readInitialEpoch(readTopLevelEpoch: () => number | null): number {
  const epoch = readTopLevelEpoch();
  if (!validEpoch(epoch)) {
    throw new SetOfMarksError(
      'SET_OF_MARKS_EPOCH_CHANGED',
      'Cannot verify the top-level document epoch before screenshot capture.',
    );
  }
  return epoch;
}

/**
 * Asserts the document is still the one the capture started on.
 *
 * @param stage Where the check runs, named in the error ("before capture").
 * @throws SetOfMarksError when the epoch moved.
 */
export function assertEpochUnchanged(
  current: number | null,
  expected: number,
  stage: string,
): void {
  if (current !== expected) {
    throw new SetOfMarksError(
      'SET_OF_MARKS_EPOCH_CHANGED',
      `The top-level document changed ${stage}; the screenshot was discarded.`,
    );
  }
}

/**
 * Reads the epoch, captures, and asserts the epoch is unchanged.
 *
 * @returns The capture, only when the whole of it came from one document.
 * @throws SetOfMarksError (`SET_OF_MARKS_EPOCH_CHANGED`) when the epoch was
 *   unreadable before the capture or changed during it; the capture is
 *   discarded, never returned.
 */
export async function withEpochGuardedCapture<T>(
  options: EpochGuardedCaptureOptions<T>,
): Promise<T> {
  const initialEpoch = readInitialEpoch(options.readTopLevelEpoch);
  const captured = await options.capture();
  assertEpochUnchanged(options.readTopLevelEpoch(), initialEpoch, 'during capture');
  return captured;
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
