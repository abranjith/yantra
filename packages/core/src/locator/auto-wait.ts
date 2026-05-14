import { LocatorAmbiguousError, LocatorNotActionableError, FrameDetachedError } from './errors.js';
import { LocatorResolverImpl } from './resolver.js';
import type {
  ActionableOptions,
  ActionableState,
  EngineLocatorChain,
  InjectedScriptHost,
  LocatorEventSink,
  SuccessResolveResult,
} from './types.js';

/**
 * Polling backoff sequence (ms) borrowed from Playwright's auto-wait implementation.
 * After the sequence is exhausted, 500ms is repeated until the deadline.
 */
const BACKOFF_SEQUENCE = [0, 20, 50, 100, 100, 500, 500, 500] as const;

type BoundingRect = { readonly top: number; readonly left: number; readonly width: number; readonly height: number };

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
 * @param chain - The chain to resolve
 * @param host - InjectedScriptHost for CDP communication
 * @param options - Timeout (defaults to 30s) and frame override
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
  const deadline = Date.now() + totalDeadlineMs;

  let lastState: ActionableState | undefined;
  let prevRect: BoundingRect | undefined;
  let backoffIndex = 0;

  while (Date.now() < deadline) {
    const delay = getNextDelay(backoffIndex++);
    if (delay > 0) {
      await sleep(Math.min(delay, deadline - Date.now()));
    }

    if (Date.now() >= deadline) break;

    const result = await resolver.resolve(chain, options);

    if (result.kind === 'failure') {
      if (result.reason === 'ambiguous') {
        // Ambiguous is non-retriable — throw immediately
        throw new LocatorAmbiguousError({
          chainName: chain.name,
          candidateIndex: result.candidatesTried.findIndex((a) => a.outcome === 'ambiguous'),
          matchCount: result.candidatesTried.find((a) => a.outcome === 'ambiguous')?.matchCount ?? 2,
          candidatesTried: result.candidatesTried,
        });
      }

      if (result.reason === 'frame_detached') {
        throw new FrameDetachedError({
          chainName: chain.name,
          frameId: options.frameId ?? 'main',
        });
      }

      // not_found or other — continue polling
      lastState = undefined;
      continue;
    }

    // Element found — check actionability
    const frameId = options.frameId ?? 'main';
    const state = await host.call<ActionableState>(frameId, 'checkActionableState', []);
    lastState = state;

    if (!state.attached) {
      // Element detached between resolve and check — retry
      continue;
    }

    if (!state.visible || !state.enabled) {
      continue;
    }

    // Stability check: compare bounding rect across two snapshots (STABILITY_WINDOW_MS apart)
    const currentRect = await host.call<BoundingRect>(frameId, 'getBoundingRect', []);
    if (prevRect !== undefined && areSameRect(prevRect, currentRect)) {
      // Rect stable — check events
      if (state.receivesEvents) {
        // All conditions met — element is actionable
        return result as SuccessResolveResult;
      }
    }
    prevRect = currentRect;

    // Wait stability window before next check
    await sleep(Math.min(STABILITY_WINDOW_MS, deadline - Date.now()));
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

function getNextDelay(index: number): number {
  if (index < BACKOFF_SEQUENCE.length) {
    return BACKOFF_SEQUENCE[index] ?? 500;
  }
  return 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref();
    }
  });
}

function areSameRect(a: BoundingRect, b: BoundingRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}
