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
 * So: read the field back, and when the readback is a *truncation* of the
 * request, try again by a different mechanism. Only truncation escalates. A
 * control that rewrites what it was given — an input mask inserting its own
 * punctuation — has accepted the value, and fighting it would replace working
 * text with a second, worse attempt.
 *
 * This module deliberately owns no `FillFailure`: the fill layer depends on
 * interaction, never the reverse, so the outcome here is self-describing and
 * the caller maps it into its own vocabulary.
 */

import type { WidgetBudget, WidgetPort, WidgetTarget } from '../widgets/types.js';

import { withAttempts, type AttemptOutcome } from './attempt.js';
import { normalizeText, type AttemptLedger } from './types.js';

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
  readonly ledger: AttemptLedger;
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
  readonly ledger: AttemptLedger;
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
}

/**
 * Enter `text` into `target`, escalating only while the control truncates it.
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
      ledger: { records: [] },
    };
  }

  // With one rung there is nothing a readback could decide, and reading is the
  // only reason this function reads at all. Skipping it is what makes the
  // no-escalation mode safe for a secret by construction rather than by care:
  // the value is never pulled back out of the page, so it cannot reach a
  // ledger, a failure detail, or a log.
  if (!allowEscalation) {
    await applyStrategy(port, target, text, 'overtype');
    return {
      ok: true,
      strategy: 'overtype',
      committed: '',
      reformatted: false,
      ledger: { records: [{ attempt: 1, strategy: 'overtype', errorCode: null, elapsedMs: 0 }] },
    };
  }

  let lastCommitted = '';
  const run = await withAttempts<TypedText, TypingFailure>(
    async (attempt) => {
      const strategy = TYPING_LADDER[attempt - 1]!;
      await applyStrategy(port, target, text, strategy);
      const committed = await readRawValue(port, target);
      lastCommitted = committed;
      if (!isTruncationOf(committed, text)) {
        return {
          ok: true,
          value: {
            ok: true,
            strategy,
            committed,
            reformatted: normalizeText(committed) !== normalizeText(text),
            // Replaced by the caller-visible ledger below; an attempt cannot
            // see the record it is itself being written into.
            ledger: { records: [] },
          },
        } satisfies AttemptOutcome<TypedText, TypingFailure>;
      }
      return {
        ok: false,
        failure: {
          ok: false,
          errorCode: 'WIDGET_NOT_COMMITTED',
          message:
            committed.length === 0
              ? `The "${target.name}" control is still empty after the value was typed.`
              : `The "${target.name}" control kept only "${committed}" of the value that was typed.`,
          observed: committed,
          ledger: { records: [] },
        },
      };
    },
    {
      maxAttempts: allowEscalation ? TYPING_LADDER.length : 1,
      deadlineMs: budget.deadlineMs,
      backoffMs: [0],
      // Every rung failure here is the same observed condition — the control
      // truncated the text — and the point of the ladder is to answer it with a
      // *different mechanism*, so it is transient by construction rather than
      // by the shared classification table.
      classify: () => 'transient',
      describe: (failure) => ({
        errorCode: failure.errorCode,
        detail: failure.observed.length > 0 ? `kept "${failure.observed}"` : 'field stayed empty',
      }),
      now: () => port.now(),
      label: (attempt) => TYPING_LADDER[attempt - 1] ?? `attempt-${attempt}`,
    },
  );

  if (run.outcome.ok) return { ...run.outcome.value, ledger: run.ledger };
  return { ...run.outcome.failure, observed: lastCommitted, ledger: run.ledger };
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

/** True when every character of `part` appears in `whole`, in order. */
function isSubsequence(part: string, whole: string): boolean {
  let cursor = 0;
  for (const character of whole) {
    if (character === part[cursor]) cursor += 1;
    if (cursor === part.length) return true;
  }
  return cursor === part.length;
}
