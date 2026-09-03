import type { ActionableState, CandidateAttempt, JsonLocatorIntent } from './types.js';

/** Chain exhausted — every candidate returned 0 matches. */
export class LocatorNotFoundError extends Error {
  override readonly name = 'LocatorNotFoundError';

  constructor(
    readonly context: {
      readonly chainName: string;
      readonly candidatesTried: readonly CandidateAttempt[];
    },
  ) {
    super(
      `Locator chain "${context.chainName}" exhausted — no candidate matched. ` +
        `Tried ${context.candidatesTried.length} candidate(s).`,
    );
  }
}

/** A candidate returned >1 matches in strict mode. */
export class LocatorAmbiguousError extends Error {
  override readonly name = 'LocatorAmbiguousError';

  constructor(
    readonly context: {
      readonly chainName: string;
      readonly candidateIndex: number;
      readonly matchCount: number;
      readonly candidatesTried: readonly CandidateAttempt[];
    },
  ) {
    super(
      `Locator chain "${context.chainName}" candidate [${context.candidateIndex}] matched ` +
        `${context.matchCount} elements — expected exactly 1 (strict mode).`,
    );
  }
}

/** Element resolved but never became actionable within the deadline. */
export class LocatorNotActionableError extends Error {
  override readonly name = 'LocatorNotActionableError';

  constructor(
    readonly context: {
      readonly chainName: string;
      readonly lastActionableState: ActionableState;
      readonly deadlineMs: number;
    },
  ) {
    const { visible, enabled, stable, receivesEvents } = context.lastActionableState;
    super(
      `Locator chain "${context.chainName}" element not actionable within ${context.deadlineMs}ms. ` +
        `Last state: visible=${visible}, enabled=${enabled}, stable=${stable}, receivesEvents=${receivesEvents}.`,
    );
  }
}

/** Frame holding the target was detached mid-resolution. */
export class FrameDetachedError extends Error {
  override readonly name = 'FrameDetachedError';

  constructor(
    readonly context: {
      readonly chainName: string;
      readonly frameId: string;
    },
  ) {
    super(
      `Frame "${context.frameId}" detached while resolving locator chain "${context.chainName}".`,
    );
  }
}

/** CSS or XPath candidate had invalid syntax. */
export class LocatorInvalidSelectorError extends Error {
  override readonly name = 'LocatorInvalidSelectorError';

  constructor(
    readonly context: {
      readonly intent: JsonLocatorIntent;
      readonly parseError: string;
    },
  ) {
    super(`Invalid selector in locator candidate: ${context.parseError}`);
  }
}
