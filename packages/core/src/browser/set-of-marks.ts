import type { Page } from 'puppeteer-core';

const CONTAINER_ID = '__yantra_set_of_marks__';

export interface SetOfMarksMark {
  readonly ref: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SetOfMarksPort {
  inject(marks: readonly SetOfMarksMark[]): Promise<void>;
  remove(): Promise<void>;
  present(): Promise<boolean>;
}

export interface SetOfMarksCaptureOptions<T> {
  readonly port: SetOfMarksPort;
  readonly marks: readonly SetOfMarksMark[];
  readonly readTopLevelEpoch: () => number | null;
  readonly capture: () => Promise<T>;
  readonly discard?: (captured: T) => Promise<void> | void;
}

export class SetOfMarksError extends Error {
  public constructor(
    public readonly code: 'SET_OF_MARKS_EPOCH_CHANGED' | 'SET_OF_MARKS_REMOVAL_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SetOfMarksError';
  }
}

/** Injects only Yantra refs, captures once, and verifies mandatory cleanup. */
export async function withSetOfMarksCapture<T>(options: SetOfMarksCaptureOptions<T>): Promise<T> {
  const initialEpoch = options.readTopLevelEpoch();
  if (!validEpoch(initialEpoch)) {
    throw new SetOfMarksError(
      'SET_OF_MARKS_EPOCH_CHANGED',
      'Cannot verify the top-level document epoch before screenshot capture.',
    );
  }
  let captured: T | undefined;
  let captureCompleted = false;
  let primaryError: unknown;
  let cleanupError: SetOfMarksError | undefined;
  let removalEpochChanged = false;
  try {
    // Mark cleanup as necessary before awaiting injection: a partial injection
    // that throws must still enter the same removal path.
    await options.port.inject(options.marks.filter(validMark));
    assertEpoch(options.readTopLevelEpoch(), initialEpoch, 'before capture');
    captured = await options.capture();
    captureCompleted = true;
    assertEpoch(options.readTopLevelEpoch(), initialEpoch, 'after capture');
  } catch (error) {
    primaryError = error;
    if (captureCompleted) await options.discard?.(captured as T);
  } finally {
    try {
      // Re-check before removal as an explicit race signal, but always attempt
      // removal even when it changed: failure cleanup is mandatory.
      const removalEpoch = options.readTopLevelEpoch();
      removalEpochChanged = removalEpoch !== initialEpoch;
      await options.port.remove();
      if (await options.port.present()) {
        cleanupError = new SetOfMarksError(
          'SET_OF_MARKS_REMOVAL_FAILED',
          'The screenshot marks overlay is still present after removal.',
        );
      }
    } catch (error) {
      cleanupError =
        error instanceof SetOfMarksError
          ? error
          : new SetOfMarksError(
              'SET_OF_MARKS_REMOVAL_FAILED',
              `Could not remove the screenshot marks overlay: ${safeMessage(error)}`,
            );
    }
  }

  if (cleanupError !== undefined) throw cleanupError;
  if (removalEpochChanged && primaryError === undefined) {
    if (captureCompleted) await options.discard?.(captured as T);
    throw new SetOfMarksError(
      'SET_OF_MARKS_EPOCH_CHANGED',
      'The top-level document changed before screenshot overlay removal.',
    );
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) throw primaryError;
    throw new Error(`Screenshot capture failed: ${safeMessage(primaryError)}`);
  }
  if (!captureCompleted) {
    throw new SetOfMarksError(
      'SET_OF_MARKS_REMOVAL_FAILED',
      'Screenshot capture completed without a capture value.',
    );
  }
  return captured as T;
}

/** Creates the real Puppeteer-backed overlay port used only by capture. */
export function puppeteerSetOfMarksPort(page: Page): SetOfMarksPort {
  return {
    inject: (marks) =>
      page.evaluate(
        (id, items) => {
          document.getElementById(id)?.remove();
          const container = document.createElement('div');
          container.id = id;
          container.setAttribute('aria-hidden', 'true');
          container.style.cssText =
            'position:fixed;inset:0;z-index:2147483647;pointer-events:none;overflow:visible';
          for (const item of items) {
            const box = document.createElement('div');
            box.style.cssText = `position:absolute;left:${item.left}px;top:${item.top}px;width:${item.width}px;height:${item.height}px;border:2px solid #e11d48;box-sizing:border-box`;
            const label = document.createElement('span');
            label.textContent = item.ref;
            label.style.cssText =
              'position:absolute;left:0;top:0;background:#e11d48;color:white;font:12px monospace;padding:1px 3px';
            box.append(label);
            container.append(box);
          }
          document.documentElement.append(container);
        },
        CONTAINER_ID,
        marks,
      ),
    remove: () => page.evaluate((id) => document.getElementById(id)?.remove(), CONTAINER_ID),
    present: () => page.evaluate((id) => document.getElementById(id) !== null, CONTAINER_ID),
  };
}

function assertEpoch(current: number | null, expected: number, stage: string): void {
  if (current !== expected) {
    throw new SetOfMarksError(
      'SET_OF_MARKS_EPOCH_CHANGED',
      `The top-level document changed ${stage}; the screenshot was discarded.`,
    );
  }
}

function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validMark(mark: SetOfMarksMark): boolean {
  return (
    /^e[1-9]\d*$/u.test(mark.ref) &&
    [mark.left, mark.top, mark.width, mark.height].every(Number.isFinite) &&
    mark.width > 0 &&
    mark.height > 0
  );
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
