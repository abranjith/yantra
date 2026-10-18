/**
 * Protected controls: which ones withhold their contents, and how a value typed
 * into one is checked without ever being read back.
 *
 * Two questions used to share one answer. "Never disclose this value" and "did
 * the value land" were both answered by a read that returned `''` for any
 * protected control — so a password that typed perfectly was then verified as
 * empty, and reported as a widget that dropped its value on release. The first
 * question is answered here by {@link classifyWithheld}; the second by a
 * {@link CommitMatch} verdict that is computed **inside the page**, against the
 * text the caller sent, so the protected value itself never crosses into Node.
 *
 * **One vocabulary, several in-page copies.** A function handed to
 * `Page.evaluate` is serialized by source and cannot import, so every in-page
 * reader re-implements the predicate and the comparator. What it cannot
 * re-implement is the token list: that is passed in as an argument from
 * {@link SENSITIVE_AUTOCOMPLETE_TOKENS}, and parity tests pin each in-page copy
 * to the Node twins below.
 */

import { isFormattingEquivalent, isTruncationOf } from './typing.js';

/**
 * Why a control's contents are withheld from every read.
 *
 * Reported on the observation entry beside `value_present`, so a field that is
 * classified as protected when it should not be is visible rather than silent.
 */
export type WithheldReason =
  /** `input[type="password"]`. */
  | 'password'
  /** The `autocomplete` attribute names a credential, one-time code, or card field. */
  | 'autocomplete'
  /** Yantra's own `data-yantra-secret` marker. */
  | 'secret_marker';

/**
 * WHATWG autofill field names whose values are never disclosed.
 *
 * Matched as whole tokens, case-insensitively, anywhere in the attribute — so
 * `section-pay cc-number` is protected and `cc-name` is not.
 */
export const SENSITIVE_AUTOCOMPLETE_TOKENS: readonly string[] = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
];

/** The attribute facts the classifier reads. A value is never among them. */
export interface ProtectedControlFacts {
  readonly passwordInput: boolean;
  readonly autocomplete: string;
  readonly secretMarker: boolean;
}

/**
 * The Node twin of the in-page predicate.
 *
 * Precedence is `password` > `autocomplete` > `secret_marker`: the first match
 * is the reason reported.
 */
export function classifyWithheld(facts: ProtectedControlFacts): WithheldReason | null {
  if (facts.passwordInput) return 'password';
  const tokens = facts.autocomplete.toLowerCase().split(/\s+/u);
  if (tokens.some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.includes(token))) {
    return 'autocomplete';
  }
  if (facts.secretMarker) return 'secret_marker';
  return null;
}

/**
 * How a protected control's raw value relates to the text it was sent.
 *
 * Evaluated in this order, first match wins.
 */
export type CommitMatch =
  /** The control is empty. */
  | 'empty'
  /** Byte-for-byte the text that was sent. */
  | 'exact'
  /** The same letters and digits with only case, spacing, or punctuation changed. */
  | 'reformatted'
  /** Strictly fewer of the sent characters, in order. */
  | 'truncated'
  /** Anything else. */
  | 'different';

/**
 * The Node twin of the in-page comparator.
 *
 * `exact` is raw equality, deliberately not the folded comparison disclosed
 * text uses: folding would call `passw0rd` an exact match for `Passw0rd!`,
 * which overstates what landed. `reformatted` is the typing ladder's own
 * equivalence rule — what a card-number mask inserting spaces produces.
 */
export function classifyCommitMatch(actual: string, expected: string): CommitMatch {
  if (actual.length === 0) return 'empty';
  if (actual === expected) return 'exact';
  if (isFormattingEquivalent(actual, expected)) return 'reformatted';
  if (isTruncationOf(actual, expected)) return 'truncated';
  return 'different';
}

/** A control's value, as much of it as may be known. */
export type CommittedValue = DisclosedValue | WithheldValue;

/** A control that discloses its contents. */
export interface DisclosedValue {
  readonly kind: 'disclosed';
  /** Whitespace-normalized text, exactly as the committed read always returned it. */
  readonly text: string;
}

/**
 * A control that withholds its contents.
 *
 * Carries what may be said about the value without saying it: whether there is
 * one, and — when the read was given the expected text — how it compares.
 */
export interface WithheldValue {
  readonly kind: 'withheld';
  readonly reason: WithheldReason;
  /** True when the control holds at least one character. */
  readonly present: boolean;
  /** Null exactly when the read was given no expected text. */
  readonly match: CommitMatch | null;
}

/** Wrap disclosed text. */
export function disclosed(text: string): DisclosedValue {
  return { kind: 'disclosed', text };
}

/**
 * The disclosed text, or null.
 *
 * **Never** maps a withheld value to `''`: that conflation is the defect this
 * module exists to remove.
 */
export function committedText(value: CommittedValue): string | null {
  return value.kind === 'disclosed' ? value.text : null;
}

/**
 * True when a read found nothing in the control.
 *
 * A protected control answers through `present`, never through its text.
 */
export function isEmptyRead(value: CommittedValue): boolean {
  return value.kind === 'disclosed' ? value.text.trim().length === 0 : !value.present;
}

/** The success verdict of a withheld read, or null when it did not verify. */
export function verifiedMatch(value: WithheldValue): 'exact' | 'reformatted' | null {
  return value.match === 'exact' || value.match === 'reformatted' ? value.match : null;
}

/**
 * What a successful fill of a protected control reports instead of `committed`.
 *
 * Caller-supplied data verifies against an in-page verdict; a stored secret is
 * committed blind and says so.
 */
export type WithheldCommit =
  | { readonly reason: WithheldReason; readonly verdict: 'exact' | 'reformatted' }
  | { readonly reason: 'stored_secret'; readonly verdict: 'unchecked' };

/** The only shape in which a withheld read may enter a failure's `details`. */
export interface WithheldDetails {
  readonly withheld: WithheldReason;
  readonly match: CommitMatch | null;
  readonly present: boolean;
}

/** Project a withheld read into failure details. Never carries the value. */
export function withheldDetails(value: WithheldValue): WithheldDetails {
  return { withheld: value.reason, match: value.match, present: value.present };
}

/**
 * Failure details describing what a control holds: `observed` when it
 * discloses, the withheld projection when it does not — never both.
 */
export function observedDetails(
  value: CommittedValue,
): { readonly observed: string } | WithheldDetails {
  return value.kind === 'disclosed' ? { observed: value.text } : withheldDetails(value);
}
