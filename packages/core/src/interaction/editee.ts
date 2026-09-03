/**
 * Find the control the page actually edits — the WHERE rung.
 *
 * The typing ladder varies mechanism: overtype, then clear-and-retype, then a
 * native setter. All three answer the same question — *how* do I get text into
 * this node — and all three are useless when the node was never the editee.
 * A trigger that opens an overlay and routes keystrokes to the overlay's own
 * input answers every rung the same way, so a fill against it spends three
 * mechanisms and 8-14 seconds to report `field stayed empty` three times.
 *
 * The fix is not another rung. It is to notice, after the first one, that the
 * text went somewhere else, and to say where.
 *
 * **There is no probe keystroke.** Rung 1 has already sent the whole value, so
 * by the time this question is worth asking the text is already wherever it was
 * going — and the requested value is itself the needle, far more distinctive
 * than one character would be. Sending another character at that point would
 * append to, and corrupt, a value that already arrived. The work here is a
 * comparison, not an action: observe, let rung 1 act, observe again.
 *
 * **It runs in ref-space, not raw DOM.** Refs are minted only by `observe()`,
 * and every consumer — `port.fill`, `port.type`, the readback, the engine's
 * re-target — addresses elements by ref. An element discovered through
 * `evaluateOn` would have no ref and could not be driven even once found, so
 * diffing `interactables[].value` by ref is what makes the answer *usable*
 * rather than merely true.
 *
 * Nothing here reads a hostname, a brand, or a selector table. The signals are
 * value flow and observed focus, which every page has.
 */

import type { AgentBrowserObservation, AgentInteractable } from '../browser/agent-controller.js';
import type { WidgetTarget } from '../widgets/types.js';

import { diffKeyed } from './differ.js';
import { normalizeText } from './types.js';

/**
 * The structural signal that decided an editee resolution.
 *
 * A fixed enum of signal names, never page text, so it carries nothing to
 * redact and can ride the sanitized ledger as-is. It is recorded on success as
 * well as failure so the classifier can be tuned later from run artifacts at no
 * extra cost.
 */
export type EditeeEvidence =
  /** One other interactable's value became the requested text. */
  | 'value-appeared-elsewhere'
  /** The page moved focus off the target, but no value landed anywhere. */
  | 'focus-moved'
  /** Nothing observable changed. */
  | 'none';

/** Where the keystrokes went. */
export type EditeeResolution =
  /** The target holds the text; it is the editee, as assumed. */
  | { readonly kind: 'same' }
  /** A different live node holds the text, and can be driven by ref. */
  | {
      readonly kind: 'delegated';
      readonly target: WidgetTarget;
      readonly evidence: EditeeEvidence;
    }
  /** The text is nowhere, or in more than one place; no re-target is safe. */
  | { readonly kind: 'inert'; readonly evidence: EditeeEvidence };

/** Structural reads the caller can supply beside the two observations. */
export interface EditeeSignals {
  /**
   * Whether the target still held focus after the keystrokes.
   *
   * Deliberately *not* used to choose an editee: focus moving proves the page
   * reacted, never that the value landed on whatever now has it. It is recorded
   * as evidence on an otherwise-inert result so a later tuning pass can tell
   * "the page ignored us" from "the page did something we could not follow".
   */
  readonly targetRetainedFocus?: boolean;
}

/**
 * Compare two observations and name the control that took the text.
 *
 * A pure function of its arguments: it observes nothing, clicks nothing, and
 * types nothing, which is what makes it directly unit-testable with no port at
 * all — and what makes it safe to call on a path that has already mutated the
 * page once.
 *
 * @param before - Observation taken before the value was typed.
 * @param after - Observation taken after the first typing rung ran.
 * @param target - The control the caller addressed.
 * @param requested - The value that was sent, used as the needle.
 * @param signals - Optional structural reads; see {@link EditeeSignals}.
 */
export function locateEditee(
  before: AgentBrowserObservation,
  after: AgentBrowserObservation,
  target: WidgetTarget,
  requested: string,
  signals: EditeeSignals = {},
): EditeeResolution {
  const wanted = normalizeText(requested);
  const focusEvidence: EditeeEvidence =
    signals.targetRetainedFocus === false ? 'focus-moved' : 'none';
  if (wanted.length === 0) return { kind: 'inert', evidence: focusEvidence };

  const self = after.interactables.find((entry) => entry.ref === target.ref);
  if (self && holds(self.value, wanted)) return { kind: 'same' };

  // The **ref** identity policy, deliberately: the caller just typed into a
  // control it holds a live ref for, every consumer of the answer drives by
  // ref, and a re-targeted drive must address a ref the port can actually
  // drive. `diffFingerprints` asks a different question and supplies a
  // different `key` — see `differ.ts`.
  //
  // `sampleCap` is infinite here and must stay that way: a capped sample would
  // silently drop the carrier and turn a resolvable delegation into `inert`.
  const diff = diffKeyed(before.interactables, after.interactables, {
    key: (entry) => entry.ref,
    changed: (left, right) => (left.value ?? '') !== (right.value ?? ''),
    sampleCap: Number.POSITIVE_INFINITY,
  });
  // An interactable absent from `before` is eligible: the overlay's own input
  // is frequently mounted by the very click that opened it, so requiring it to
  // have existed beforehand would exclude the exact shape this rung is for. It
  // arrives as `appeared`, and a non-empty value on it still counts as a
  // carrier.
  const changed = [
    ...diff.changed.map((pair) => pair.after),
    ...diff.appeared.filter((entry) => (entry.value ?? '') !== ''),
  ];
  const carriers = changed.filter(
    (entry) => entry.ref !== target.ref && holds(entry.value, wanted),
  );

  // Exactly one, or nothing. Two controls that both took the text is a page
  // this function cannot read, and picking one of them would re-target a fill
  // onto a control the caller never asked for — strictly worse than reporting
  // that the mechanism ladder has nothing left to try.
  if (carriers.length === 1) {
    return {
      kind: 'delegated',
      target: toWidgetTarget(carriers[0]!),
      evidence: 'value-appeared-elsewhere',
    };
  }
  if (carriers.length > 1) return { kind: 'inert', evidence: 'value-appeared-elsewhere' };
  return { kind: 'inert', evidence: focusEvidence };
}

/**
 * Whether an observed value carries the requested text.
 *
 * Containment rather than equality, because a control that appends its own
 * formatting or a trailing marker has still taken the value — and this question
 * only ever runs against a value the caller just sent, so a coincidental
 * containment would have to be a control that already held the exact request.
 */
function holds(value: string | undefined, wanted: string): boolean {
  const actual = normalizeText(value ?? '');
  return actual.length > 0 && actual.includes(wanted);
}

/**
 * Build the drivable target for a discovered editee.
 *
 * Identical to how every other consumer converts an observed interactable, so a
 * re-targeted drive is the same operation as the original one — not a parallel
 * path with its own idea of what a target is.
 */
function toWidgetTarget(entry: AgentInteractable): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}
