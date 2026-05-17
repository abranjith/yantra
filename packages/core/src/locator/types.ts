import type { ElementHandle } from 'puppeteer-core';

/** Full ARIA 1.2 core role set resolved by the Yantra locator engine. */
export type AriaRole =
  | 'button'
  | 'link'
  | 'textbox'
  | 'checkbox'
  | 'radio'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'tab'
  | 'tabpanel'
  | 'dialog'
  | 'alert'
  | 'heading'
  | 'img'
  | 'table'
  | 'row'
  | 'cell'
  | 'columnheader'
  | 'rowheader'
  | 'rowgroup'
  | 'list'
  | 'listitem'
  | 'menu'
  | 'menuitem'
  | 'menubar'
  | 'navigation'
  | 'main'
  | 'banner'
  | 'contentinfo'
  | 'complementary'
  | 'search'
  | 'searchbox'
  | 'form'
  | 'region'
  | 'article'
  | 'switch'
  | 'progressbar'
  | 'slider'
  | 'spinbutton'
  | 'status'
  | 'tooltip'
  | 'figure'
  | 'definition'
  | 'group'
  | 'math'
  | 'meter'
  | 'paragraph'
  | 'separator';

/** Structural relationship between an anchor element and a target. */
export type RelativeRelation =
  | 'next-sibling'
  | 'previous-sibling'
  | 'following'
  | 'preceding'
  | 'ancestor'
  | 'descendant'
  | 'labeled-by';

/**
 * Typed intent for a single locator candidate. Discriminated union; each variant
 * corresponds to one resolution strategy in the injected bundle.
 */
export type LocatorIntent =
  | {
      readonly kind: 'role';
      readonly role: AriaRole;
      readonly name?: string | RegExp;
      readonly exact?: boolean;
    }
  | { readonly kind: 'testid'; readonly attribute?: string; readonly value: string }
  | { readonly kind: 'label'; readonly text: string | RegExp; readonly exact?: boolean }
  | { readonly kind: 'placeholder'; readonly text: string | RegExp; readonly exact?: boolean }
  | {
      readonly kind: 'text';
      readonly text: string | RegExp;
      readonly exact?: boolean;
      readonly normalize?: boolean;
    }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'xpath'; readonly expression: string }
  | {
      readonly kind: 'relative';
      readonly anchor: LocatorIntent;
      readonly relation: RelativeRelation;
      readonly targetRole?: AriaRole;
    };

/** One candidate in the ordered chain. */
export interface EngineLocatorCandidate {
  readonly intent: LocatorIntent;
  /** How this candidate was produced. `reanchored` is Phase 2 only. */
  readonly source: 'recorded' | 'authored' | 'reanchored';
  readonly notes?: string;
}

/** Ordered candidate chain with a human-readable name. */
export interface EngineLocatorChain {
  readonly name: string;
  readonly candidates: readonly EngineLocatorCandidate[];
  /** When true, >1 matches is a hard failure. Default true. */
  readonly strict: boolean;
}

/** Per-candidate attempt record for diagnostics. */
export interface CandidateAttempt {
  readonly index: number;
  readonly intent: LocatorIntent;
  /** 0, 1, or >1 */
  readonly matchCount: number;
  readonly outcome: 'matched' | 'no_match' | 'ambiguous' | 'error';
  readonly errorMessage?: string;
  readonly durationMs: number;
}

/** Result of LocatorResolver.resolve. */
export type ResolveResult =
  | {
      readonly kind: 'success';
      readonly elementHandle: ElementHandle;
      readonly usedCandidateIndex: number;
      readonly candidatesTried: readonly CandidateAttempt[];
      readonly durationMs: number;
    }
  | {
      readonly kind: 'failure';
      readonly reason:
        | 'not_found'
        | 'ambiguous'
        | 'hit_intercepted'
        | 'not_actionable'
        | 'frame_detached';
      readonly candidatesTried: readonly CandidateAttempt[];
      readonly lastError?: Error;
      readonly durationMs: number;
    };

/** Convenience alias for the success variant of ResolveResult. */
export type SuccessResolveResult = Extract<ResolveResult, { kind: 'success' }>;

/** Per-element actionability state used by the auto-wait loop. */
export interface ActionableState {
  /** bounding rect > 0 AND not display:none/visibility:hidden */
  readonly visible: boolean;
  /** no [disabled] attr, no aria-disabled="true" */
  readonly enabled: boolean;
  /** bounding rect unchanged for ≥ 100 ms */
  readonly stable: boolean;
  /** elementFromPoint(cx,cy) === el || el.contains(eFP) */
  readonly receivesEvents: boolean;
  /** still in document */
  readonly attached: boolean;
}

/** Result of the hit-target check performed before synthesized clicks. */
export type HitTargetCheckResult =
  | { readonly kind: 'ok'; readonly coordinates: { readonly x: number; readonly y: number } }
  | {
      readonly kind: 'intercepted';
      readonly interceptor: {
        readonly tagName: string;
        readonly accessibleName?: string;
        readonly testid?: string;
      };
      readonly coordinates: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: 'outside_viewport';
      readonly coordinates: { readonly x: number; readonly y: number };
    };

/** Options for LocatorResolver.resolve. */
export interface ResolveOptions {
  /** Override the frame to resolve in. Defaults to main frame. */
  readonly frameId?: string;
  /** Per-candidate timeout in ms. Defaults to 5000. */
  readonly candidateTimeoutMs?: number;
}

/** Options for resolveActionable. */
export interface ActionableOptions extends ResolveOptions {
  /** Total deadline for the auto-wait loop in ms. Defaults to 30000. */
  readonly timeoutMs?: number;
}

/** Record-time ranking output consumed by the recorder (FEAT-008). */
export interface CandidateRanking {
  readonly target: { readonly tagName: string; readonly accessibleName?: string };
  readonly candidates: readonly RankedCandidate[];
}

export interface RankedCandidate {
  readonly intent: LocatorIntent;
  /** weight * specificity * stability */
  readonly score: number;
  /** Short string explaining why this candidate won its rank slot. */
  readonly rationale: string;
}

/** Options for the ranking algorithm. */
export interface RankingOptions {
  readonly topN?: number;
  /** Custom test-id attribute aliases. Defaults to ['data-testid','data-test-id','data-qa','data-test']. */
  readonly testidAttributes?: readonly string[];
}

/** Event emitted after every resolve call for analytics (TASK-014). */
export interface LocatorResolutionEvent {
  readonly kind: 'locator_resolution';
  readonly chain_name: string;
  readonly candidates_tried: number;
  readonly winning_index: number | null;
  readonly outcome:
    | 'success'
    | 'not_found'
    | 'ambiguous'
    | 'hit_intercepted'
    | 'not_actionable'
    | 'frame_detached';
  readonly duration_ms: number;
  readonly frame_id: string;
}

/** Sink for locator resolution telemetry events. */
export interface LocatorEventSink {
  emit(event: LocatorResolutionEvent): void;
}

/**
 * Node-side interface for calling into the InjectedScript bundle
 * via CDP Runtime.evaluate / Runtime.callFunctionOn.
 */
export interface InjectedScriptHost {
  /** Ensures the injected bundle is loaded into the given frame. Idempotent. */
  ensureInjected(frameId: string): Promise<void>;
  /**
   * Calls a named function on window.__yantra with JSON-serializable args.
   * Returns the JSON-serialized result.
   */
  call<T>(frameId: string, fn: string, args: readonly unknown[]): Promise<T>;
  /**
   * Calls a function in the page and returns the result as an ElementHandle
   * (the CDP objectId is preserved — not serialized to JSON).
   */
  callHandle(frameId: string, expression: string): Promise<ElementHandle | null>;
}

/** The injected bundle's public API surface. Shared as .d.ts only. */
export interface InjectedAPI {
  resolveCandidate(encodedIntent: JsonLocatorIntent, strict: boolean): CandidateResolution;
  checkActionableState(): ActionableState;
  checkHitTarget(): HitTargetCheckResult;
}

/** JSON-safe form of LocatorIntent (RegExp → { __isRegExp, pattern, flags }). */
export type JsonLocatorIntent =
  | {
      readonly kind: 'role';
      readonly role: AriaRole;
      readonly name?: string | JsonRegex;
      readonly exact?: boolean;
    }
  | { readonly kind: 'testid'; readonly attribute?: string; readonly value: string }
  | { readonly kind: 'label'; readonly text: string | JsonRegex; readonly exact?: boolean }
  | { readonly kind: 'placeholder'; readonly text: string | JsonRegex; readonly exact?: boolean }
  | {
      readonly kind: 'text';
      readonly text: string | JsonRegex;
      readonly exact?: boolean;
      readonly normalize?: boolean;
    }
  | { readonly kind: 'css'; readonly selector: string }
  | { readonly kind: 'xpath'; readonly expression: string }
  | {
      readonly kind: 'relative';
      readonly anchor: JsonLocatorIntent;
      readonly relation: RelativeRelation;
      readonly targetRole?: AriaRole;
    };

export interface JsonRegex {
  readonly __isRegExp: true;
  readonly pattern: string;
  readonly flags: string;
}

/** Serializable result from the injected resolveCandidate call. */
export interface CandidateResolution {
  readonly count: number;
  /** Set when count === 1: opaque slot key used to retrieve the element handle. */
  readonly slotKey?: string;
}
