/**
 * Get text into a control, and confirm it actually arrived.
 *
 * Nothing used to check. `fill()` selected the existing value with a
 * triple-click and overtyped it, and whatever the control held afterwards was
 * simply assumed to be the request. On a page that re-renders its own input in
 * response to the first keystroke, the leading characters are swallowed — a
 * typed airport code arrived as a two-letter fragment, the site's autocomplete
 * dutifully offered a city matching the fragment, and the whole run proceeded
 * from a value nobody had asked for.
 *
 * So: read the field back, and try another mechanism unless the control holds
 * the requested letters and numbers. An input mask inserting punctuation has
 * accepted the value; a control replacing `DFW` with unrelated text has not.
 *
 * This module deliberately owns no `FillFailure`: the fill layer depends on
 * interaction, never the reverse, so the outcome here is self-describing and
 * the caller maps it into its own vocabulary.
 */

import type { AgentBrowserObservation } from '../browser/agent-controller.js';
import type { WidgetBudget, WidgetPort, WidgetTarget } from '../widgets/types.js';

import type { EditeeEvidence } from './editee.js';
import { runEscalationPlan, toWireLedger, type SerializedVerdict } from './escalation.js';
import { normalizeText } from './types.js';
import { buildTypingPlan } from './typing-plan.js';

/** How the text was ultimately entered. */
export type TypingStrategy = 'overtype' | 'clear-then-type' | 'native-setter';

/** The ladder, in the order it is climbed. */
export const TYPING_LADDER: readonly TypingStrategy[] = [
  'overtype',
  'clear-then-type',
  'native-setter',
];

/** Per-key pacing for the second rung; slow enough for a debounced re-render. */
const DELIBERATE_KEY_DELAY_MS = 60;

/** Text committed to a control, and how it got there. */
export interface TypedText {
  readonly ok: true;
  readonly strategy: TypingStrategy;
  /** What the control holds now — not necessarily what was requested. */
  readonly committed: string;
  /** True when the control rewrote the value rather than truncating it. */
  readonly reformatted: boolean;
  /** The verdicts this commit contributed, already in the wire projection. */
  readonly attempted: readonly SerializedVerdict[];
}

/** The control would not hold the text, or there was no room to try. */
export interface TypingFailure {
  readonly ok: false;
  /** Stable code the caller re-uses verbatim in its own failure vocabulary. */
  readonly errorCode: 'WIDGET_NOT_COMMITTED' | 'WIDGET_TARGET_UNREACHABLE';
  readonly message: string;
  /** What the control actually holds now. */
  readonly observed: string;
  /** Set when the ladder never started because the budget was spent. */
  readonly reason?: 'budget';
  /**
   * The live control the page routed the keystrokes to.
   *
   * Present only when the WHERE rung found exactly one, and the reason the
   * ladder stopped at rung 1: varying the mechanism against a node that is not
   * the editee cannot succeed, so two more rungs would buy nothing but time.
   */
  readonly editee?: WidgetTarget;
  /** Which structural signal identified — or failed to identify — the editee. */
  readonly editeeEvidence?: EditeeEvidence;
  /** The verdicts this commit contributed, already in the wire projection. */
  readonly attempted: readonly SerializedVerdict[];
}

/** The outcome of trying to place text in a control. */
export type CommitTextOutcome = TypedText | TypingFailure;

/** Options governing one {@link commitText} call. */
export interface CommitTextOptions {
  /**
   * Whether the ladder may climb past its first rung.
   *
   * Secrets pin this to `false`, and doing so also disables the readback —
   * see {@link commitText}. Rung 3 would place the value in an `evaluateOn`
   * argument and the readback would pull it back out of the page, and neither
   * is acceptable for a credential: the secret path commits blind and verifies
   * nothing, exactly as it did before this module existed.
   */
  readonly allowEscalation?: boolean;
  /**
   * Enable the WHERE rung.
   *
   * Opt-in, and supplied by the caller rather than taken from `port.observe`
   * directly, so the cost belongs to whoever decided the rung was worth it —
   * a plain text box with no popup to delegate to pays nothing at all.
   *
   * **It is never supplied on the secret path**: locating an editee means
   * searching every observed interactable for the value that was sent, which
   * for a credential is a readback of secret-derived state compared against the
   * whole page. See the security note on `fillSecretField`.
   */
  readonly editee?: EditeeProbeOptions;
}

/** How the WHERE rung gets its two observations. */
export interface EditeeProbeOptions {
  /** Takes a fresh observation. Called once, after rung 1 comes back empty. */
  readonly observe: () => Promise<AgentBrowserObservation>;
  /**
   * The before-picture, when the caller already has one.
   *
   * The agent's fill tools resolve a field from an observation taken
   * immediately beforehand, which *is* the before-picture — so passing it makes
   * the ordinary path cost nothing extra and the delegated path cost exactly
   * one observation. Without it the rung takes its own baseline before typing.
   */
  readonly baseline?: AgentBrowserObservation;
}

/**
 * Enter `text` into `target`, escalating until it is semantically preserved.
 *
 * Returns the committed text rather than the requested text: what the control
 * holds is the fact, and the caller decides what it means.
 */
export async function commitText(
  port: WidgetPort,
  target: WidgetTarget,
  text: string,
  budget: WidgetBudget,
  options: CommitTextOptions = {},
): Promise<CommitTextOutcome> {
  const allowEscalation = options.allowEscalation ?? true;
  if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
    return {
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      message: 'The fill action budget was exhausted before the value could be typed.',
      observed: '',
      reason: 'budget',
      attempted: [],
    };
  }

  // The before-picture, because "which control's value changed" is not a
  // question that can be asked after the fact. Reused from the caller when it
  // already has one; only a caller with none pays for a read here, and only
  // when it asked for the rung at all.
  const probe = options.editee;
  const before = probe ? (probe.baseline ?? (await probe.observe())) : null;
  const plan = buildTypingPlan({
    port,
    target,
    text,
    budget,
    allowEscalation,
    ...(probe ? { probe } : {}),
    before,
    operations: {
      apply: applyStrategy,
      read: readRawValue,
      targetHasFocus,
      equivalent: isFormattingEquivalent,
      truncated: isTruncationOf,
    },
  });
  const run = await runEscalationPlan(plan);
  // The verdicts this plan appended, in the one wire shape. No legacy record is
  // built here and none is built downstream of here.
  const attempted = toWireLedger(run.ledger);
  if (run.outcome === null) {
    return {
      ok: false,
      errorCode: 'WIDGET_TARGET_UNREACHABLE',
      message: 'The fill action budget was exhausted before the value could be typed.',
      observed: '',
      reason: 'budget',
      attempted,
    };
  }
  return run.outcome.ok
    ? { ...run.outcome.value, attempted }
    : { ...run.outcome.failure, attempted };
}

/**
 * Whether the target still holds focus.
 *
 * Read structurally and used only as *evidence*: focus moving proves the page
 * reacted to the keystrokes, never that the value landed on whatever now has
 * it, so it never selects an editee. See {@link locateEditee}.
 */
async function targetHasFocus(port: WidgetPort, target: WidgetTarget): Promise<boolean> {
  return port.evaluateOn(target.ref, (element) => element.ownerDocument.activeElement === element);
}

/** Enter the text by one specific mechanism. */
async function applyStrategy(
  port: WidgetPort,
  target: WidgetTarget,
  text: string,
  strategy: TypingStrategy,
): Promise<void> {
  if (strategy === 'overtype') {
    await port.fill(target.ref, text);
    return;
  }
  if (strategy === 'clear-then-type') {
    await port.clear(target.ref);
    await port.type(target.ref, text, { delayMs: DELIBERATE_KEY_DELAY_MS });
    return;
  }
  // Last rung. A framework-controlled input ignores `element.value = x` because
  // React and friends install their own `value` setter on the instance and use
  // it to decide that nothing changed; going through the prototype descriptor is
  // what makes the assignment visible to that change tracking.
  //
  // All but the final character go in that way, and the final character is a
  // genuine keystroke, because a page whose suggestions are driven by real key
  // events rather than by `input` gets nothing from a programmatic write alone.
  //
  // A control that refuses keystrokes outright would lose that last character,
  // so the rung finishes by checking and, if needed, writing the whole value the
  // programmatic way. Waking the listeners is worth one attempt; it is not worth
  // committing a value one character short.
  const head = text.slice(0, -1);
  const tail = text.slice(-1);
  await port.clear(target.ref);
  if (head.length > 0) await setNativeValue(port, target, head);
  if (tail.length > 0) {
    await port.type(target.ref, tail, { delayMs: DELIBERATE_KEY_DELAY_MS });
    if (isTruncationOf(await readRawValue(port, target), text)) {
      await setNativeValue(port, target, text);
    }
  }
}

/**
 * Write a value through the prototype `value` setter and announce it.
 *
 * The prototype descriptor matters: an instance-level setter installed by a
 * framework swallows the write and reports no change, which is exactly why a
 * plain assignment leaves such a control empty.
 */
async function setNativeValue(
  port: WidgetPort,
  target: WidgetTarget,
  value: string,
): Promise<void> {
  await port.evaluateOn(
    target.ref,
    (element, next) => {
      const isInput = element instanceof HTMLInputElement;
      if (!isInput && !(element instanceof HTMLTextAreaElement)) return;
      const view = element.ownerDocument.defaultView;
      const prototype = isInput
        ? (view?.HTMLInputElement.prototype ?? HTMLInputElement.prototype)
        : (view?.HTMLTextAreaElement.prototype ?? HTMLTextAreaElement.prototype);
      // Detaching the setter is the whole technique: it is invoked with an
      // explicit receiver so the framework's own instance-level setter, which
      // would swallow the write, is bypassed.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, next);
      else element.value = next;
      const EventCtor = view?.Event ?? Event;
      element.dispatchEvent(new EventCtor('input', { bubbles: true }));
      element.dispatchEvent(new EventCtor('change', { bubbles: true }));
    },
    value,
  );
}

/**
 * The control's own raw value, with no accessible-name fallbacks.
 *
 * Deliberately narrower than `readCommitted`: this asks "did the characters
 * land in the box", and a picker's accessible label answering on the box's
 * behalf would mask exactly the truncation being looked for.
 */
async function readRawValue(port: WidgetPort, target: WidgetTarget): Promise<string> {
  return port.evaluateOn(target.ref, (element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value.replace(/\s+/g, ' ').trim();
    }
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  });
}

/**
 * True when the control kept strictly less of the text than was sent.
 *
 * Subsequence, not prefix: a control that drops the *first* keystroke leaves a
 * suffix, one that drops a middle keystroke leaves neither, and both are the
 * same defect. A longer or differently-punctuated readback is a reformat and is
 * never treated as loss.
 */
export function isTruncationOf(committed: string, requested: string): boolean {
  const actual = normalizeText(committed);
  const wanted = normalizeText(requested);
  if (wanted.length === 0) return false;
  if (actual.length === 0) return true;
  if (actual.length >= wanted.length) return false;
  return isSubsequence(actual, wanted);
}

/** True for the same letters/numbers with only case, punctuation, or spacing changed. */
export function isFormattingEquivalent(committed: string, requested: string): boolean {
  const actual = formattingKey(committed);
  const wanted = formattingKey(requested);
  return wanted.length > 0 && actual === wanted;
}

function formattingKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** True when every character of `part` appears in `whole`, in order. */
function isSubsequence(part: string, whole: string): boolean {
  let cursor = 0;
  for (const character of whole) {
    if (character === part[cursor]) cursor += 1;
    if (cursor === part.length) return true;
  }
  return cursor === part.length;
}

/**
 * How many interactables the WHERE rung's observations may carry.
 *
 * The same cap the re-acquisition path already uses: an editee that a bounded
 * observation cannot see is one no other part of the engine could have driven
 * either, so widening it here would only produce targets nothing else can use.
 */
export const EDITEE_OBSERVATION_CAP = 400;

/** The standard probe for a caller holding a port and nothing else. */
export function editeeProbe(
  port: WidgetPort,
  baseline?: AgentBrowserObservation,
): EditeeProbeOptions {
  return {
    observe: () => port.observe({ cap: EDITEE_OBSERVATION_CAP, trackDigest: false }),
    ...(baseline ? { baseline } : {}),
  };
}

/** Text entered into a control, and which control ended up holding it. */
export interface EnteredText {
  readonly typed: CommitTextOutcome;
  /** The control that was actually driven — the target, or its editee. */
  readonly target: WidgetTarget;
  /** Set only when the drive re-targeted. */
  readonly editee: WidgetTarget | null;
  /** Every verdict both passes contributed, in order, in the wire projection. */
  readonly attempted: readonly SerializedVerdict[];
}

/**
 * Type into the control the page actually edits.
 *
 * The first pass runs with the WHERE rung enabled. When it reports that the
 * keystrokes landed in a different live node, the drive re-targets and types
 * there instead — with the rung disabled the second time, because a delegation
 * chain is a page this cannot read and one more observation pair would only
 * find the same thing again.
 *
 * The substitution is reported the way `tieBreak` already reports a narrowed
 * resolution: the caller is told which control was edited, never left to infer
 * it from a value appearing somewhere it did not ask about.
 */
export async function enterText(
  port: WidgetPort,
  target: WidgetTarget,
  text: string,
  budget: WidgetBudget,
  probe?: EditeeProbeOptions,
): Promise<EnteredText> {
  const first = await commitText(port, target, text, budget, probe ? { editee: probe } : {});
  if (first.ok || first.editee === undefined) {
    return { typed: first, target, editee: null, attempted: first.attempted };
  }

  const editee = first.editee;
  const second = await commitText(port, editee, text, budget);
  // No hand-built re-target record and no renumbering splice: both passes run
  // on the one run, so they already land in order, and the re-target fact is
  // carried by the `locate-editee` verdict and by the `editee` disclosure the
  // caller actually reads.
  return {
    typed: second,
    target: editee,
    editee,
    attempted: [...first.attempted, ...second.attempted],
  };
}
