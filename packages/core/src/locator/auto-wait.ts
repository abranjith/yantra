import { LocatorAmbiguousError, LocatorNotActionableError, FrameDetachedError } from './errors.js';
import { LocatorResolverImpl } from './resolver.js';
import type {
  ActionableOptions,
  ActionableRequirement,
  ActionableState,
  EngineLocatorChain,
  InjectedScriptHost,
  LocatorEventSink,
  ResolveResult,
  SuccessResolveResult,
} from './types.js';

/**
 * Polling backoff sequence (ms) borrowed from Playwright's auto-wait implementation.
 * After the sequence is exhausted, 500ms is repeated until the deadline.
 */
const BACKOFF_SEQUENCE = [0, 20, 50, 100, 100, 500, 500, 500] as const;

interface BoundingRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const STABILITY_WINDOW_MS = 100;

/**
 * Resolves a locator chain and waits until the element is actionable.
 *
 * An element is actionable when all four conditions are simultaneously true:
 *   visible:       bounding rect > 0, not hidden/display:none
 *   stable:        bounding rect unchanged for ≥ 100ms
 *   enabled:       no [disabled] or aria-disabled="true"
 *   receivesEvents: elementFromPoint(cx,cy) lands on element or descendant
 *
 * `options.requirement` narrows that contract for callers that are not about to
 * synthesize pointer input. Only click/fill need the full check: the
 * `receivesEvents` probe hit-tests the element's centre against the viewport,
 * so an element taller than the viewport (`body`, a page-length results
 * container) never passes it and a read of that element would time out.
 *   - `actionable` (default) — all four conditions. Click/fill.
 *   - `visible` — attached + visible + enabled + stable. Extract/assert and
 *     `wait_for: visible`.
 *   - `attached` — present in the document only. `wait_for: attached`.
 *
 * @param chain - The chain to resolve
 * @param host - InjectedScriptHost for CDP communication
 * @param options - Timeout (defaults to 30s), requirement level, frame override
 * @param eventSink - Optional telemetry sink
 * @returns The success result carrying the ElementHandle
 * @throws {LocatorNotFoundError} when chain exhausted
 * @throws {LocatorAmbiguousError} when a candidate is ambiguous (non-retriable)
 * @throws {LocatorNotActionableError} when deadline reached before actionable
 * @throws {FrameDetachedError} when the frame is detached mid-poll
 */
export async function resolveActionable(
  chain: EngineLocatorChain,
  host: InjectedScriptHost,
  options: ActionableOptions = {},
  eventSink?: LocatorEventSink,
): Promise<SuccessResolveResult> {
  const resolver = new LocatorResolverImpl(host, eventSink);
  const totalDeadlineMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requirement: ActionableRequirement = options.requirement ?? 'actionable';
  const deadline = Date.now() + totalDeadlineMs;

  let lastState: ActionableState | undefined;
  let lastAmbiguity: Extract<ResolveResult, { kind: 'failure' }> | undefined;
  let prevRect: BoundingRect | undefined;
  let backoffIndex = 0;

  while (Date.now() < deadline) {
    const delay = getNextDelay(backoffIndex++);
    if (delay > 0) {
      await sleep(Math.min(delay, deadline - Date.now()));
    }

    if (Date.now() >= deadline) break;

    let result: ResolveResult;
    try {
      result = await resolver.resolve(chain, options);
    } catch (err) {
      // A click/navigate on a previous step may still be tearing down the old
      // document. While that happens, injected-script calls throw
      // "Execution context was destroyed" (or the injection wrapper carrying
      // it). That is a transient condition: keep polling until the new document
      // settles, exactly as `not_found` is retried. Genuinely fatal errors
      // (e.g. the page closed) still propagate.
      if (isTransientNavigationError(err)) {
        lastState = undefined;
        prevRect = undefined;
        continue;
      }
      throw err;
    }

    if (result.kind === 'failure') {
      if (result.reason === 'ambiguous') {
        // The chain was exhausted with at least one candidate matching several
        // elements. Keep polling rather than failing outright: mid-render pages
        // routinely show a duplicate for a few frames (a skeleton row beside
        // its loaded replacement) that resolves itself. The remembered result
        // is what gets thrown if the deadline arrives first, so the author is
        // told about the ambiguity instead of a misleading "not found".
        lastAmbiguity = result;
        lastState = undefined;
        continue;
      }

      if (result.reason === 'frame_detached') {
        throw new FrameDetachedError({
          chainName: chain.name,
          frameId: options.frameId ?? 'main',
        });
      }

      // not_found or other — continue polling. The page has since stopped
      // showing a duplicate, so an earlier ambiguity is no longer the story.
      lastAmbiguity = undefined;
      lastState = undefined;
      continue;
    }

    // Element found — check actionability. These injected-script calls can also
    // race an in-flight navigation, so the same transient-error handling applies.
    try {
      const frameId = options.frameId ?? 'main';
      const state = await host.call<ActionableState>(frameId, 'checkActionableState', []);
      lastState = state;

      if (!state.attached) {
        // Element detached between resolve and check — retry
        continue;
      }

      // `attached` asks for nothing beyond presence: a hidden or zero-box
      // element still satisfies it.
      if (requirement === 'attached') {
        return result;
      }

      if (!state.visible || !state.enabled) {
        continue;
      }

      // Stability check: compare bounding rect across two snapshots (STABILITY_WINDOW_MS apart)
      const currentRect = await host.call<BoundingRect>(frameId, 'getBoundingRect', []);
      if (prevRect !== undefined && areSameRect(prevRect, currentRect)) {
        // Rect stable. `visible` stops here; only pointer input additionally
        // requires the centre-point hit test to land on the element.
        if (requirement === 'visible' || state.receivesEvents) {
          return result;
        }
      }
      prevRect = currentRect;

      // Wait stability window before next check
      await sleep(Math.min(STABILITY_WINDOW_MS, deadline - Date.now()));
    } catch (err) {
      if (isTransientNavigationError(err)) {
        lastState = undefined;
        prevRect = undefined;
        continue;
      }
      throw err;
    }
  }

  if (lastAmbiguity !== undefined) {
    const ambiguous = lastAmbiguity.candidatesTried.find((a) => a.outcome === 'ambiguous');
    throw new LocatorAmbiguousError({
      chainName: chain.name,
      candidateIndex: ambiguous?.index ?? 0,
      matchCount: ambiguous?.matchCount ?? 2,
      candidatesTried: lastAmbiguity.candidatesTried,
    });
  }

  throw new LocatorNotActionableError({
    chainName: chain.name,
    lastActionableState: lastState ?? {
      visible: false,
      enabled: false,
      stable: false,
      receivesEvents: false,
      attached: false,
    },
    deadlineMs: totalDeadlineMs,
  });
}

/**
 * Detects errors that arise from an in-flight page navigation tearing down the
 * document mid-resolution (e.g. a preceding click that submits a form). These
 * are transient: once the new document loads, the injected runtime is
 * re-installed and the element resolves. The auto-wait loop retries them until
 * the deadline instead of surfacing them as a fatal `unexpected` failure.
 */
function isTransientNavigationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return (
    message.includes('execution context was destroyed') ||
    message.includes('execution context is not available') ||
    message.includes('cannot find context') ||
    message.includes('most likely because of a navigation')
  );
}

function getNextDelay(index: number): number {
  if (index < BACKOFF_SEQUENCE.length) {
    return BACKOFF_SEQUENCE[index] ?? 500;
  }
  return 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function areSameRect(a: BoundingRect, b: BoundingRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}
