import type { AgentBrowserObservation } from '../browser/agent-controller.js';
import type { ChoiceSubstitution } from '../interaction/choice.js';
import type { MutableRunState, VerdictEvidence } from '../interaction/escalation.js';
import type { InteractionFailureCause } from '../interaction/types.js';

/**
 * Semantic family implemented by a widget driver.
 *
 * `combobox` is its own family rather than a variant of `option` because the
 * two are reached differently: an option control is opened and chosen from,
 * while a combobox is *typed into* and then chosen from. Routing them together
 * would make the engine ask a listbox to accept text, or a typeahead to be
 * opened before it has anything to show.
 */
export type WidgetFamily = 'date' | 'option' | 'combobox';

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
  /**
   * Empty a text control with real selection and key events.
   *
   * `fill` already replaces a value by overtyping a triple-click selection,
   * which is enough for most controls and is the reason this is separate rather
   * than folded in: the typing ladder needs *clearing* and *entering* as
   * distinct steps so it can re-enter text at a different pace without
   * re-running the select-all that some controls answer by re-rendering.
   */
  clear(ref: string): Promise<unknown>;
  /**
   * Type text into the focused control without clearing it first.
   *
   * `delayMs` paces the keystrokes. A control that drops characters under a
   * fast burst — the shape that turned a typed airport code into a two-letter
   * fragment matching an unrelated city — usually keeps all of them when the
   * page is given time to process each one.
   */
  type(ref: string, text: string, options?: { readonly delayMs?: number }): Promise<unknown>;
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
  /**
   * Advance a widget container's **own** scrollable region by one step.
   *
   * A port method rather than a helper over `evaluate` precisely so it is
   * counted: scrolling mutates the page, and a virtualized list that reveals
   * its rows by scrolling must pay for them against the same action budget as
   * every click and keystroke.
   *
   * Resolves the nearest scrollable region searched from the container's own
   * subtree outward to the container itself. `window`,
   * `document.scrollingElement`, `document.body`, and `document.documentElement`
   * are excluded by construction — scrolling the window would move the whole
   * page under an agent that asked only for a list to be advanced.
   *
   * Returns `null` when the container owns no scrollable region, which is a
   * normal named outcome rather than a failure.
   *
   * **An action, never a probe**: reachable from `drive()` only. Detection must
   * never mutate page state.
   */
  scrollContainer(container: WidgetContainer, step?: number): Promise<ScrollFrame | null>;
  /** Injectable millisecond clock used to bound polling and paging. */
  now(): number;
}

/**
 * What one bounded container-scroll step observed.
 *
 * `scrollHeight` / `clientHeight` are **evidence, not a stop condition**: an
 * environment without a layout engine reports them as `0`, which makes `atEnd`
 * vacuously true there and would terminate a scan instantly. Termination is
 * identity-first — see `VirtualListStop`.
 */
export interface ScrollFrame {
  /** The region's scroll offset after the step. */
  readonly scrollTop: number;
  /** The region's full scrollable extent. Evidence only. */
  readonly scrollHeight: number;
  /** The region's visible extent. Evidence only. */
  readonly clientHeight: number;
  /** Whether `scrollTop` actually differs from its value before the step. */
  readonly moved: boolean;
  /** Whether the region is at its end, by its own reported geometry. */
  readonly atEnd: boolean;
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

/** Serializable location of a widget container in the live DOM. */
export interface WidgetContainer {
  readonly path: readonly number[];
}

/** Verified success returned by a widget driver. */
export interface WidgetSuccess {
  readonly ok: true;
  readonly driver: string;
  readonly committed: string;
  readonly actions: number;
  /**
   * The label of the option the driver actually clicked, when it chose one.
   *
   * This is what makes the committed value verifiable on its own terms. A
   * widget asked for "DFW" that offers and commits "Dallas" has answered the
   * request — checking the result against the *typed text* instead reported
   * that success as `WIDGET_NOT_COMMITTED`, and the caller spent the rest of
   * its run working around a fill that had already landed.
   */
  readonly chosen?: string;
  /** What the widget showed at the moment of choosing, capped by the driver. */
  readonly offered?: readonly string[];
  /** A structurally indistinguishable choice made and disclosed by the driver. */
  readonly substitution?: ChoiceSubstitution;
  /**
   * The control the driver re-targeted to, when the page routed the edit away.
   *
   * A trigger that opens an overlay and forwards keystrokes to the overlay's
   * own input is edited through that input, not through the node the caller
   * named. Saying so is what stops a caller concluding, from a trigger that
   * stayed empty, that its fill did not land.
   */
  readonly editee?: WidgetTarget;
  /**
   * What this driver discloses about **how** it resolved.
   *
   * A driver no longer owns a ledger. It reports counts and structural tokens —
   * how many candidates were indistinguishable, how far a container was
   * scrolled — and the runner records them on the rung that ran it, so there is
   * one sequence and one place that decides what may be serialized.
   */
  readonly evidence?: VerdictEvidence;
  /**
   * True when the driver's own actions already released the widget's popup.
   *
   * Clicking a suggestion closes the list on most pages, and a caller that
   * cannot tell that from "the list is still up" either reports a clean fill as
   * having left an overlay across the page, or spends a release action on a
   * popup that is already gone.
   */
  readonly released?: boolean;
  /**
   * True when the control rewrote the value rather than taking it as typed.
   *
   * An input mask turning "5551234567" into "(555) 123-4567" has accepted the
   * value; reporting the difference as a mismatch condemns a fill the page
   * plainly took.
   */
  readonly reformatted?: boolean;
  /**
   * The floating container this driver operated, when it had one.
   *
   * Releasing a picker is part of committing to it — many hold the selection in
   * their own copy of the field and write it back to the page only on close —
   * so the caller has to know which container to release. Re-deriving it from
   * the trigger afterwards cannot distinguish the picker the driver just drove
   * from an unrelated dialog the field happens to sit inside, and closing the
   * wrong one is worse than closing nothing. The driver already knows, so it
   * says.
   */
  readonly container?: WidgetContainer;
}

/** Typed, model-actionable widget failure. */
export interface WidgetFailure {
  readonly ok: false;
  readonly errorCode: WidgetErrorCode;
  /**
   * Why this happened, as distinct from what it is called.
   *
   * Internal. The fill layer uses it to pick the message, hint and required
   * details together; it is dropped before anything crosses the tool seam, so
   * the model still sees only `error_code`, `message`, and `details`.
   */
  readonly cause: InteractionFailureCause;
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
  /**
   * Container-scroll steps one operation may charge.
   *
   * Declared on the budget rather than hardcoded in a driver so a caller can
   * lower it and a test can pin it — the same reason `maxPagingSteps` lives
   * here.
   */
  readonly maxScrollSteps: number;
  /**
   * The run this operation joins, when a caller already owns one.
   *
   * The budget is the only thing that already flows unchanged from `fillField`
   * through `WidgetDriver.drive` and `commitText` into every plan builder, so
   * the run rides here rather than widening a dozen signatures. Absent means
   * "this call is the root and creates the state".
   */
  readonly run?: MutableRunState;
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
  /**
   * Confidence read from a container the engine-owned open probe just revealed.
   *
   * Optional, and reachable only from that stage. Some controls say nothing
   * about themselves until they are opened — a bare textbox that mounts a
   * calendar on click carries no popup attribute, no format hint and no
   * rendered value — so `detect` correctly scores them zero and correctly
   * refuses to click to find out. Once the engine has opened one deliberately,
   * and knows the container came from that click, the driver can be asked what
   * it makes of it. A driver without this member is simply never asked.
   */
  detectOpen?(port: WidgetPort, target: WidgetTarget, container: WidgetContainer): Promise<number>;
  /** Drive and verify the semantic intent within the supplied bounds. */
  drive(
    port: WidgetPort,
    target: WidgetTarget,
    intent: WidgetIntent,
    budget: WidgetBudget,
  ): Promise<WidgetOutcome>;
}

/**
 * Default bounded work allowance for one widget operation.
 *
 * The deadline funds in-call recovery — a typing ladder, a driver fallback, a
 * suggestion list waited out until it settles — rather than pushing each of
 * those back to the caller as a failed turn. It stays well inside the agent
 * runtime's 45s per-tool timeout, which remains the outer bound.
 */
export function defaultWidgetBudget(port: Pick<WidgetPort, 'now'>): WidgetBudget {
  return {
    deadlineMs: port.now() + 25_000,
    maxPagingSteps: 12,
    maxActions: 32,
    maxScrollSteps: 8,
  };
}

/**
 * Construct a fully populated typed widget failure.
 *
 * `cause` is required, and sits beside the code rather than being inferred from
 * it later: a driver knows why it gave up, and reconstructing that at the seam
 * from whichever detail keys happen to be present is exactly the arrangement
 * this argument replaces.
 */
export function widgetFailure(
  errorCode: WidgetErrorCode,
  cause: InteractionFailureCause,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  retryable = true,
): WidgetFailure {
  return { ok: false, errorCode, cause, message, retryable, details };
}
