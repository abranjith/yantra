import type { AgentBrowserObservation } from '../browser/agent-controller.js';

/** Semantic family implemented by a widget driver. */
export type WidgetFamily = 'date' | 'option';

/**
 * Narrow browser seam used by deterministic widget drivers.
 *
 * The port deliberately exposes settled click/fill operations rather than a
 * raw Puppeteer page, keeping navigation, popup, and dialog behavior owned by
 * the browser controller.
 */
export interface WidgetPort {
  /** Read the current page and refresh opaque element references. */
  observe(options?: {
    readonly cap?: number;
    readonly trackDigest?: boolean;
  }): Promise<AgentBrowserObservation>;
  /** Perform a settle-aware click through an opaque element reference. */
  click(ref: string): Promise<unknown>;
  /** Perform a settle-aware fill through an opaque element reference. */
  fill(ref: string, value: string): Promise<unknown>;
  /** Evaluate a serializable function against an observed element. */
  evaluateOn<T, Args extends readonly unknown[]>(
    ref: string,
    fn: (element: HTMLElement, ...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T>;
  /** Evaluate a serializable function in the page document. */
  evaluate<T, Args extends readonly unknown[]>(
    fn: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<T>;
  /** Send a keyboard key to the active page. */
  press(key: string): Promise<void>;
  /** Injectable millisecond clock used to bound polling and paging. */
  now(): number;
}

/** Model-observed trigger or form field passed to a driver. */
export interface WidgetTarget {
  /** Opaque reference minted by the latest observation. */
  readonly ref: string;
  /** Observed ARIA role. */
  readonly role: string;
  /** Accessible name. */
  readonly name: string;
  /** Nearest labelled widget container, when one was found. */
  readonly group: string | null;
  /** Current non-secret committed value, when available. */
  readonly value: string | null;
}

/** Semantic operation requested by a widget tool. */
export type WidgetIntent =
  | { readonly kind: 'date'; readonly date: string }
  | { readonly kind: 'date_range'; readonly from: string; readonly to: string }
  | { readonly kind: 'option'; readonly value: string };

/**
 * Stable failure codes returned by every widget driver.
 *
 * `WIDGET_ELEMENT_REPLACED` exists because a stale ref is not a model error
 * here. The caller may have named the control rather than referencing it, and
 * the ref that went stale was minted internally — reporting it back as
 * `STALE_ELEMENT_REF` tells the model to re-observe something it never saw.
 */
export type WidgetErrorCode =
  | 'WIDGET_NOT_RECOGNIZED'
  | 'WIDGET_DID_NOT_OPEN'
  | 'WIDGET_TARGET_UNREACHABLE'
  | 'WIDGET_AMBIGUOUS_CHOICE'
  | 'WIDGET_MAPPING_UNSAFE'
  | 'WIDGET_NOT_COMMITTED'
  | 'WIDGET_ELEMENT_REPLACED';

/** Verified success returned by a widget driver. */
export interface WidgetSuccess {
  readonly ok: true;
  readonly driver: string;
  readonly committed: string;
  readonly actions: number;
}

/** Typed, model-actionable widget failure. */
export interface WidgetFailure {
  readonly ok: false;
  readonly errorCode: WidgetErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
}

/** Result of a semantic widget operation. */
export type WidgetOutcome = WidgetSuccess | WidgetFailure;

/** Absolute and count-based bounds applied to one driver invocation. */
export interface WidgetBudget {
  readonly deadlineMs: number;
  readonly maxPagingSteps: number;
  readonly maxActions: number;
}

/** Pattern-based implementation of one stateful widget protocol. */
export interface WidgetDriver {
  /** Stable implementation identifier surfaced in successful results. */
  readonly kind: string;
  /** Semantic family accepted by the driver. */
  readonly family: WidgetFamily;
  /**
   * Return confidence in `[0, 1]` from closed-state reads only. Detection must
   * never click, fill, or otherwise open a widget.
   */
  detect(port: WidgetPort, target: WidgetTarget): Promise<number>;
  /** Drive and verify the semantic intent within the supplied bounds. */
  drive(
    port: WidgetPort,
    target: WidgetTarget,
    intent: WidgetIntent,
    budget: WidgetBudget,
  ): Promise<WidgetOutcome>;
}

/** Default bounded work allowance for one widget operation. */
export function defaultWidgetBudget(port: Pick<WidgetPort, 'now'>): WidgetBudget {
  return {
    deadlineMs: port.now() + 15_000,
    maxPagingSteps: 12,
    maxActions: 24,
  };
}

/** Construct a fully populated typed widget failure. */
export function widgetFailure(
  errorCode: WidgetErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  retryable = true,
): WidgetFailure {
  return { ok: false, errorCode, message, retryable, details };
}
