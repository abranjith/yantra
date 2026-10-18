import { renderInteractionMessage } from '../interaction/messages.js';
import { PROTECTED_ACTION_RE } from '../interaction/protected-actions.js';

import { BrowserActionabilityError } from './actionability-errors.js';

/**
 * What is covering a control, named structurally.
 *
 * A closed set, and the only part of an obstruction that is not page-derived —
 * which is exactly why it is the field that drives retryability and the field
 * that is safe to log verbatim. Nothing here consults a host, brand or URL.
 */
export type ObstructionKind = 'busy-indicator' | 'modal-dialog' | 'fixed-overlay' | 'plain-overlay';

/**
 * Precedence, fixed and tested.
 *
 * Busy wins first deliberately: mis-reading a spinner as a modal converts a
 * transient into a terminal and loses a retry the page would have satisfied,
 * while the reverse error — a momentarily `aria-busy` dialog read as busy —
 * costs only a bounded retry before the same report is produced.
 */
export const OBSTRUCTION_PRECEDENCE = [
  'busy-indicator',
  'modal-dialog',
  'fixed-overlay',
  'plain-overlay',
] as const satisfies readonly ObstructionKind[];

/** The one `cause` each kind reports under `ELEMENT_OBSTRUCTED`. */
export const OBSTRUCTION_CAUSE = {
  'busy-indicator': 'obstructed-by-busy-indicator',
  'modal-dialog': 'obstructed-by-modal',
  'fixed-overlay': 'obstructed-by-fixed-overlay',
  'plain-overlay': 'obstructed-by-plain-overlay',
} as const satisfies Record<ObstructionKind, string>;

/**
 * How far above the intercepting node an overlay wrapper may sit.
 *
 * Matches `overlay-dismiss.ts`'s `FLOAT_ANCESTRY`, so the run's two overlay
 * concepts see the same containers.
 */
export const OVERLAY_ANCESTRY = 4;
/** Bound on a page-derived overlay name before it reaches a message or log. */
export const OVERLAY_NAME_MAX_CHARS = 120;
/** Most dismiss candidates ever offered to the agent. */
export const OBSTRUCTION_CANDIDATE_CAP = 5;
/** Most controls ever described while looking for dismiss candidates. */
export const CANDIDATE_SCAN_CAP = 20;

/**
 * Controls that could plausibly dismiss an overlay.
 *
 * Deliberately not `a[href]`: a link is navigation, and navigation is never a
 * dismissal.
 */
export const CANDIDATE_SELECTOR =
  'button, [role="button"], input[type="button"], input[type="submit"]';

/**
 * The broad *offer* lexicon: names worth handing to the agent as refs.
 *
 * Matching this is not permission to press anything — it only decides what is
 * shown. {@link AUTO_CLEARANCE_RE} decides what the engine may press.
 */
export const DISMISS_CANDIDATE_RE =
  /\b(?:close|dismiss|decline|reject|no thanks|not now|maybe later|skip|continue without)\b|^[×✕✖✗✘❌╳xX]$/i;

/**
 * The strict *auto-clearance* allowlist: names the engine may press once.
 *
 * An allowlist rather than a denylist, because the failure mode is pressing a
 * button on the user's behalf. "Continue without" is offered but never pressed
 * — it commits to proceeding, which is a decision, not a dismissal. A bare
 * close glyph is offered but never pressed either: an unlabelled icon is
 * ambiguous by construction.
 */
export const AUTO_CLEARANCE_RE =
  /\b(?:close|dismiss|decline|reject|no thanks|not now|maybe later|skip)\b/i;

/** How an overlay names itself. Shared with FEAT-035's dialog delta. */
export interface OverlayIdentity {
  readonly role: string;
  readonly name: string;
}

/** One dismiss control found inside the obstructing subtree. */
export interface ObstructionCandidate {
  /** An opaque ref registered on the controller; never invented. */
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  /** {@link PROTECTED_ACTION_RE} matched this name. */
  readonly protectedAction: boolean;
  /** Passed the strict allowlist and is not protected. Only these are pressed. */
  readonly autoClearable: boolean;
}

/** Why no clearance press happened. `null` when one did. */
export type ClearanceSkipReason =
  | 'no-eligible-candidate'
  | 'already-spent-this-call'
  | 'never-dismissed-kind';

/**
 * Outcome of the one clearance press, re-checked at the original coordinate.
 *
 * A `'cleared'` value is deliberately unrepresentable: a cleared obstruction
 * produces no failure at all.
 */
export type ClearanceResult = 'still-obstructed' | 'different-obstruction';

/** The record a blocked pointer pre-flight produces. */
export interface Obstruction {
  readonly kind: ObstructionKind;
  readonly identity: OverlayIdentity;
  /** The viewport coordinate that was tested — audit proof, and no page text. */
  readonly point: { readonly x: number; readonly y: number };
  readonly clearanceAttempted: boolean;
  readonly clearanceSkipped: ClearanceSkipReason | null;
  readonly clearanceResult: ClearanceResult | null;
  readonly candidates: readonly ObstructionCandidate[];
  /** True when {@link OBSTRUCTION_CANDIDATE_CAP} elided candidates. */
  readonly candidatesTruncated: boolean;
}

/**
 * One node on the composed path from the intercepting node upward.
 *
 * Collected in the page as plain data so classification, root selection and
 * identity are ordinary Node-side functions with ordinary unit tests, rather
 * than logic that exists only inside a serialized `evaluate`.
 */
export interface OverlayNodeSummary {
  readonly role: string;
  readonly name: string;
  readonly ariaBusy: boolean;
  /** `aria-modal="true"` or an open `<dialog>` — the page saying so outright. */
  readonly modal: boolean;
  /** Computed `position`, verbatim. */
  readonly position: string;
}

/** Classification of one composed chain: kind, overlay root, identity. */
export interface ObstructionClassification {
  readonly kind: ObstructionKind;
  /** Index into the chain of the outermost overlay container. */
  readonly rootIndex: number;
  readonly identity: OverlayIdentity;
}

const BUSY_ROLE = 'progressbar';
const MODAL_ROLES = new Set(['dialog', 'alertdialog']);
const FLOATING_POSITIONS = new Set(['fixed', 'sticky', 'absolute']);
const PINNED_POSITIONS = new Set(['fixed', 'sticky']);

/**
 * Decide what is covering the click point, and which container to name.
 *
 * `chain[0]` is the node the hit test landed on; later entries are its composed
 * ancestors, at most {@link OVERLAY_ANCESTRY} of them. The kind is decided over
 * the whole chain under {@link OBSTRUCTION_PRECEDENCE}; the root is the
 * **outermost** overlay container in it, chosen the way `overlay-dismiss.ts`
 * picks one, so a listbox nested inside a modal reports the modal.
 */
export function classifyObstruction(
  chain: readonly OverlayNodeSummary[],
): ObstructionClassification {
  const hit = chain[0];
  if (!hit) {
    throw new Error('classifyObstruction requires at least the intercepting node.');
  }
  const bounded = chain.slice(0, OVERLAY_ANCESTRY);
  const busy = bounded.some((node) => node.ariaBusy || node.role === BUSY_ROLE);
  const modal = bounded.some((node) => node.modal || MODAL_ROLES.has(node.role));
  const pinned = bounded.some((node) => PINNED_POSITIONS.has(node.position));
  const kind: ObstructionKind = busy
    ? 'busy-indicator'
    : modal
      ? 'modal-dialog'
      : pinned
        ? 'fixed-overlay'
        : 'plain-overlay';

  let rootIndex = 0;
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const node = bounded[index]!;
    if (node.modal || MODAL_ROLES.has(node.role) || FLOATING_POSITIONS.has(node.position)) {
      rootIndex = index;
      break;
    }
  }
  const root = bounded[rootIndex] ?? hit;
  return {
    kind,
    rootIndex,
    identity: { role: root.role, name: boundedName(root.name) },
  };
}

/** Collapse whitespace and cap a page-derived overlay or control name. */
export function boundedName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim();
  return collapsed.length > OVERLAY_NAME_MAX_CHARS
    ? `${collapsed.slice(0, OVERLAY_NAME_MAX_CHARS - 1)}…`
    : collapsed;
}

/** A control described inside the obstructing subtree, before ref minting. */
export interface DescribedCandidate {
  readonly role: string;
  readonly name: string;
  /** Position in the scan, so the caller can pair a survivor with its handle. */
  readonly index: number;
}

/** One survivor of the dismiss lexicons, with both safety flags decided. */
export interface EligibleCandidate extends DescribedCandidate {
  readonly protectedAction: boolean;
  readonly autoClearable: boolean;
}

/** The dismiss controls worth offering, and whether the cap elided any. */
export interface CandidateSelection {
  readonly selected: readonly EligibleCandidate[];
  readonly truncated: boolean;
}

/**
 * Keep the dismiss-shaped controls, mark what may be pressed, and cap the list.
 *
 * Three independent gates decide `autoClearable`, and all three are mandatory:
 * the strict allowlist, the {@link PROTECTED_ACTION_RE} veto, and — enforced by
 * the caller, which only ever scans inside the obstructing subtree — containment.
 */
export function selectObstructionCandidates(
  described: readonly DescribedCandidate[],
): CandidateSelection {
  const matching: EligibleCandidate[] = described
    .filter((candidate) => DISMISS_CANDIDATE_RE.test(candidate.name.trim()))
    .map((candidate) => {
      const protectedAction = PROTECTED_ACTION_RE.test(candidate.name);
      return {
        index: candidate.index,
        role: candidate.role,
        name: boundedName(candidate.name),
        protectedAction,
        autoClearable: !protectedAction && AUTO_CLEARANCE_RE.test(candidate.name.trim()),
      };
    });
  return {
    selected: matching.slice(0, OBSTRUCTION_CANDIDATE_CAP),
    truncated: matching.length > OBSTRUCTION_CANDIDATE_CAP,
  };
}

/** The snake_cased projection recorded in `tool-calls.jsonl`. */
export function obstructionDetails(obstruction: Obstruction): Readonly<Record<string, unknown>> {
  return {
    kind: obstruction.kind,
    obstruction: { role: obstruction.identity.role, name: obstruction.identity.name },
    point: { x: obstruction.point.x, y: obstruction.point.y },
    clearance_attempted: obstruction.clearanceAttempted,
    clearance_skipped: obstruction.clearanceSkipped,
    clearance_result: obstruction.clearanceResult,
    candidates: obstruction.candidates.map((candidate) => ({
      ref: candidate.ref,
      role: candidate.role,
      name: candidate.name,
      protected: candidate.protectedAction,
      auto_clearable: candidate.autoClearable,
    })),
    candidates_truncated: obstruction.candidatesTruncated,
  };
}

/**
 * A pointer action refused because something else owns the click point.
 *
 * Never `ELEMENT_HIDDEN`: a covered element is visible, and conflating the two
 * sends the agent to re-observe when the fix is to dismiss.
 *
 * `message` here is the bounded, **unsanitized** default, used by direct
 * controller tests. The agent seam re-renders it from the same catalog template
 * over sanitized details before either the model or an artifact sees it — see
 * `browserFailure` in `packages/agent/src/adapters/pi/tools/browser-common.ts`.
 */
export class ElementObstructedError extends BrowserActionabilityError {
  public override readonly details: Readonly<Record<string, unknown>> & {
    readonly kind: ObstructionKind;
  };

  public constructor(public readonly obstruction: Obstruction) {
    const details = obstructionDetails(obstruction);
    super(
      'ELEMENT_OBSTRUCTED',
      renderInteractionMessage(
        'actionability',
        'ELEMENT_OBSTRUCTED',
        OBSTRUCTION_CAUSE[obstruction.kind],
        details,
      ).message,
      details,
    );
    this.name = 'ElementObstructedError';
    this.details = details as Readonly<Record<string, unknown>> & { kind: ObstructionKind };
  }
}

/**
 * Describe candidate controls in the page, in one pass over the given handles.
 *
 * Serialized into the page, so it must reference nothing from module scope. It
 * receives the very handles the caller holds, which is what keeps metadata and
 * handles aligned — a second selector pass could return a different order and
 * silently pair a name with the wrong element.
 */
export function describeCandidatesInPage(
  ...elements: readonly Element[]
): readonly { readonly role: string; readonly name: string }[] {
  return elements.map((element) => {
    const explicit = element.getAttribute('role');
    const tag = element.tagName.toLowerCase();
    const labelledBy = element.getAttribute('aria-labelledby');
    const labelled = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' ')
      : '';
    const name =
      element.getAttribute('aria-label') ??
      (labelled.trim().length > 0 ? labelled : null) ??
      (tag === 'input' ? element.getAttribute('value') : null) ??
      element.getAttribute('title') ??
      element.textContent ??
      '';
    return {
      role: explicit && explicit.length > 0 ? explicit : tag === 'input' ? 'button' : tag,
      name: name.replace(/\s+/g, ' ').trim(),
    };
  });
}
