import { renderInteractionMessage } from '../interaction/messages.js';

/** Expected stale-ref failure that directs the agent back to observation. */
export class StaleElementRefError extends Error {
  public readonly code = 'STALE_ELEMENT_REF' as const;
  public constructor(ref: string, reason?: string) {
    super(
      renderInteractionMessage('actionability', 'STALE_ELEMENT_REF', 'stale-ref', {
        ref,
        ...(reason === undefined ? {} : { reason }),
      }).message,
    );
    this.name = 'StaleElementRefError';
  }
}

/** Stable codes an actionability pre-flight can answer with. */
export type BrowserActionabilityCode =
  | 'ELEMENT_HIDDEN'
  | 'ELEMENT_DISABLED'
  | 'OPTION_NOT_FOUND'
  | 'ELEMENT_OBSTRUCTED';

/**
 * Expected hidden/disabled/unmatched-option/obstructed actionability failure.
 *
 * `details` is the snake_cased payload the tool seam records verbatim in
 * `tool-calls.jsonl`; only `ELEMENT_OBSTRUCTED` carries one today, and
 * {@link ElementObstructedError} is the subclass that makes its `kind` required.
 *
 * These classes live in their own module rather than beside the controller
 * because the obstruction protocol (`obstruction.ts`, `pointer-preflight.ts`)
 * throws them and the controller calls that protocol — sharing a module would
 * be an import cycle. `agent-controller.ts` re-exports them, so every existing
 * import site is unchanged.
 */
export class BrowserActionabilityError extends Error {
  public constructor(
    public readonly code: BrowserActionabilityCode,
    message: string,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'BrowserActionabilityError';
  }
}

/** The shared `ELEMENT_HIDDEN` failure; the element lost its layout box. */
export function hiddenError(): BrowserActionabilityError {
  return new BrowserActionabilityError(
    'ELEMENT_HIDDEN',
    renderInteractionMessage('actionability', 'ELEMENT_HIDDEN', 'hidden', {}).message,
  );
}
