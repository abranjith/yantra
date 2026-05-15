import { type FrameDetachedError } from './errors.js';
import { encodeIntent } from './intent-codec.js';
import type {
  CandidateAttempt,
  EngineLocatorChain,
  InjectedScriptHost,
  LocatorEventSink,
  LocatorResolutionEvent,
  ResolveOptions,
  ResolveResult,
} from './types.js';

const DEFAULT_CANDIDATE_TIMEOUT_MS = 5000;
const DEFAULT_FRAME_ID = 'main';

/**
 * Node-side LocatorResolver implementation.
 *
 * Walks candidate chains in order, delegating resolution to the InjectedScript
 * bundle via the InjectedScriptHost. Emits resolution metrics after every call.
 *
 * Algorithm:
 *   1. For each candidate, encode intent → JSON, call injected resolveCandidate.
 *   2. count === 1 → success; retrieve element handle via callHandle.
 *   3. count > 1 && strict → ambiguous failure; walk stops immediately.
 *   4. count === 0 → no match; continue to next candidate.
 *   5. Chain exhausted → not_found failure.
 *   6. Each candidate call wrapped in per-candidate timeout.
 */
export class LocatorResolverImpl {
  constructor(
    private readonly host: InjectedScriptHost,
    private readonly eventSink?: LocatorEventSink,
  ) {}

  /**
   * Resolves a locator chain against the current page.
   *
   * @param chain - The chain to resolve (name + ordered candidates + strict flag)
   * @param options - Optional frame ID and per-candidate timeout override
   * @returns A ResolveResult — success carries an ElementHandle; failure carries a reason.
   *
   * @example
   * const result = await resolver.resolve({ name: 'Sign in', candidates: [...], strict: true });
   * if (result.kind === 'success') { ... result.elementHandle ... }
   */
  async resolve(chain: EngineLocatorChain, options: ResolveOptions = {}): Promise<ResolveResult> {
    const frameId = options.frameId ?? DEFAULT_FRAME_ID;
    const candidateTimeoutMs = options.candidateTimeoutMs ?? DEFAULT_CANDIDATE_TIMEOUT_MS;
    const startTime = Date.now();
    const candidatesTried: CandidateAttempt[] = [];

    await this.host.ensureInjected(frameId);

    for (let i = 0; i < chain.candidates.length; i++) {
      const candidate = chain.candidates[i];
      if (!candidate) continue;

      const candidateStart = Date.now();

      let matchCount = 0;
      let outcome: CandidateAttempt['outcome'];
      let errorMessage: string | undefined;

      try {
        const encodedIntent = encodeIntent(candidate.intent);

        const resolution = await Promise.race([
          this.host.call<{ count: number; slotKey?: string }>(frameId, 'resolveCandidate', [
            encodedIntent,
            chain.strict,
          ]),
          this.timeoutReject(
            candidateTimeoutMs,
            `candidate [${i}] timed out after ${candidateTimeoutMs}ms`,
          ),
        ]);

        matchCount = resolution.count;

        if (matchCount === 1) {
          outcome = 'matched';
          const candidateDuration = Date.now() - candidateStart;

          candidatesTried.push({
            index: i,
            intent: candidate.intent,
            matchCount: 1,
            outcome: 'matched',
            durationMs: candidateDuration,
          });

          // Retrieve the element handle (CDP RemoteObject → ElementHandle)
          const elementHandle = await this.host.callHandle(
            frameId,
            'window.__yantra.getSlotElement()',
          );

          // Clear the slot
          await this.host.call(frameId, 'clearSlot', []).catch(() => undefined);

          const durationMs = Date.now() - startTime;
          this.emitEvent(chain, i, 'success', candidatesTried, durationMs, frameId);

          if (!elementHandle) {
            // Element disappeared between resolve and retrieval — treat as not_found
            candidatesTried[candidatesTried.length - 1] = {
              index: i,
              intent: candidate.intent,
              matchCount: 0,
              outcome: 'no_match',
              durationMs: candidateDuration,
            };
            continue;
          }

          return {
            kind: 'success',
            elementHandle,
            usedCandidateIndex: i,
            candidatesTried: [...candidatesTried],
            durationMs,
          };
        }

        if (matchCount > 1 && chain.strict) {
          outcome = 'ambiguous';
          candidatesTried.push({
            index: i,
            intent: candidate.intent,
            matchCount,
            outcome: 'ambiguous',
            durationMs: Date.now() - candidateStart,
          });

          const durationMs = Date.now() - startTime;
          this.emitEvent(chain, null, 'ambiguous', candidatesTried, durationMs, frameId);

          return {
            kind: 'failure',
            reason: 'ambiguous',
            candidatesTried: [...candidatesTried],
            durationMs,
          };
        }

        // count === 0 (or count > 1 non-strict): no match, continue
        outcome = 'no_match';
      } catch (err) {
        if (this.isFrameDetachedError(err)) {
          const durationMs = Date.now() - startTime;
          candidatesTried.push({
            index: i,
            intent: candidate.intent,
            matchCount: 0,
            outcome: 'error',
            errorMessage: 'frame detached',
            durationMs: Date.now() - candidateStart,
          });
          this.emitEvent(chain, null, 'frame_detached', candidatesTried, durationMs, frameId);
          return {
            kind: 'failure',
            reason: 'frame_detached',
            candidatesTried: [...candidatesTried],
            lastError: err instanceof Error ? err : new Error(String(err)),
            durationMs,
          };
        }

        outcome = 'error';
        errorMessage = err instanceof Error ? err.message : String(err);
      }

      candidatesTried.push({
        index: i,
        intent: candidate.intent,
        matchCount,
        outcome,
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        durationMs: Date.now() - candidateStart,
      });
    }

    const durationMs = Date.now() - startTime;
    this.emitEvent(chain, null, 'not_found', candidatesTried, durationMs, frameId);

    return {
      kind: 'failure',
      reason: 'not_found',
      candidatesTried: [...candidatesTried],
      durationMs,
    };
  }

  private timeoutReject(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  private isFrameDetachedError(err: unknown): err is FrameDetachedError {
    return (
      err instanceof Error &&
      (err.name === 'FrameDetachedError' ||
        err.message.toLowerCase().includes('frame was detached') ||
        err.message.toLowerCase().includes('frame detached'))
    );
  }

  private emitEvent(
    chain: EngineLocatorChain,
    winningIndex: number | null,
    outcome: LocatorResolutionEvent['outcome'],
    candidatesTried: readonly CandidateAttempt[],
    durationMs: number,
    frameId: string,
  ): void {
    if (!this.eventSink) return;
    this.eventSink.emit({
      kind: 'locator_resolution',
      chain_name: chain.name,
      candidates_tried: candidatesTried.length,
      winning_index: winningIndex,
      outcome,
      duration_ms: durationMs,
      frame_id: frameId,
    });
  }
}
