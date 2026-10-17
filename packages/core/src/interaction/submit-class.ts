/**
 * Submit-class classification for `effects.submit: forbidden` (FEAT-054).
 *
 * A control is submit-class when activating it would submit its form. Two
 * signals, both site-neutral:
 *
 * - **Structural**: the control is a native submit button — a `<button>`
 *   whose resolved `type` is `submit` (which covers a typeless `<button>`), or
 *   an `<input type="submit|image">` — **and** it has a form owner, including
 *   ownership through the `form=` attribute. A submit-typed button outside any
 *   form submits nothing, so it does not count.
 * - **Name**: the control's accessible name matches the one protected-action
 *   lexicon ({@link PROTECTED_ACTION_RE}).
 *
 * Structural wins when both fire, so the reported signal is the stronger one.
 * The classifier is pure; the facts come from one read-only element
 * evaluation (`AgentBrowserController.submitFacts`).
 */

import { PROTECTED_ACTION_RE } from './protected-actions.js';

/** The DOM facts submit-class classification reads from one element. */
export interface SubmitFacts {
  /** Lowercase tag name, such as `button`, `input`, or `a`. */
  readonly tag: string;
  /** The element's resolved `type` property (lowercase), or null when it has none. */
  readonly resolvedType: string | null;
  /** True when the element has a form owner (`element.form !== null`). */
  readonly hasFormOwner: boolean;
}

/** Which signal classified a control as submit-class. */
export type SubmitSignal = 'structural' | 'name';

/** Input types that submit their form owner when activated. */
const SUBMIT_INPUT_TYPES: ReadonlySet<string> = new Set(['submit', 'image']);

/**
 * Classifies a click target as submit-class.
 *
 * @param facts The element's facts, or null when they could not be read.
 * @param name The target's accessible name.
 * @returns `structural`, `name`, or null when the target is not submit-class.
 */
export function classifySubmitTarget(facts: SubmitFacts | null, name: string): SubmitSignal | null {
  if (facts !== null && facts.hasFormOwner && isSubmitControl(facts)) return 'structural';
  return PROTECTED_ACTION_RE.test(name) ? 'name' : null;
}

function isSubmitControl(facts: SubmitFacts): boolean {
  if (facts.tag === 'button') return facts.resolvedType === 'submit';
  if (facts.tag === 'input') {
    return facts.resolvedType !== null && SUBMIT_INPUT_TYPES.has(facts.resolvedType);
  }
  return false;
}
