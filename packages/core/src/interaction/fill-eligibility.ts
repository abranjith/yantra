/**
 * Which form controls "fill every eligible field" covers (FEAT-054).
 *
 * The engine decides eligibility from DOM state; the model never declares an
 * exemption. A control is exempt when it is part of a human-verification
 * widget, hidden or not rendered, disabled, read-only, or a file upload.
 * Protected-type controls (passwords, sensitive `autocomplete` tokens) are
 * eligible: the run fills them with caller-supplied synthetic data like any
 * other field.
 *
 * Human verification reuses the documented challenge-widget markers
 * ({@link CHALLENGE_MARKERS}), which are cross-site widget components, never a
 * host or brand. Nothing here is keyed to a site.
 */

import type { FillExemption } from '@yantra/protocol';

import { CHALLENGE_MARKERS } from '../extraction/response-classifier.js';

/** The DOM facts exemption classification reads from one control. */
export interface FillControlFacts {
  /** The control or an ancestor `fieldset` is disabled. */
  readonly disabled: boolean;
  /** The control is `readonly` or `aria-readonly="true"`. */
  readonly readOnly: boolean;
  /** Lowercase `type` of an `<input>`, or null for other elements. */
  readonly inputType: string | null;
  /** The control is `type=hidden`, `hidden`, `display:none`, or has no layout box. */
  readonly hidden: boolean;
  /**
   * Lowercase `id`, `class`, `name`, and attribute names of the control and of
   * its widget container, where challenge-widget markers would appear.
   */
  readonly markerText: string;
}

/** Marker tokens that make a control part of a human-verification widget. */
const VERIFICATION_TOKENS: readonly string[] = [
  ...CHALLENGE_MARKERS.widgets.map((marker) => marker.token),
  CHALLENGE_MARKERS.formCaptcha.token,
];

/**
 * Classifies one control's exemption, in fixed precedence:
 * `human_verification` > `hidden` > `disabled` > `read_only` > `file_input`.
 *
 * @returns The exemption, or null when the control is eligible.
 */
export function classifyFillExemption(facts: FillControlFacts): FillExemption | null {
  const markers = facts.markerText.toLowerCase();
  if (VERIFICATION_TOKENS.some((token) => markers.includes(token))) return 'human_verification';
  if (facts.hidden || facts.inputType === 'hidden') return 'hidden';
  if (facts.disabled) return 'disabled';
  if (facts.readOnly) return 'read_only';
  if (facts.inputType === 'file') return 'file_input';
  return null;
}

/** One fillable control in a census. */
export interface FillCensusControl {
  /** The opaque ref the fill tools resolve through, on the census document. */
  readonly ref: string;
  /** Radio/checkbox group or paired-control key; grouped controls count once. */
  readonly groupKey: string | null;
  /** A bounded, sanitized label for the Brief's exemption list. */
  readonly label: string;
  /** Why the engine exempted it, or null when it is eligible. */
  readonly exemption: FillExemption | null;
}

/**
 * A read-only census of the current top-level document's fillable controls,
 * the denominator of `fill.coverage: 'all_eligible'`. Produced by FEAT-055's
 * complete inventory; `complete` is false whenever a bound or a read failure
 * cut it short, and an incomplete census never yields `met`.
 */
export interface FillCensus {
  /** The top-level committed-document epoch the census was read on. */
  readonly epoch: number | null;
  readonly host: string;
  readonly complete: boolean;
  readonly controls: readonly FillCensusControl[];
}

/** Where a run reads its form census from. */
export interface FillCensusSource {
  /** The census of the current document, or null when none can be taken. */
  census(): Promise<FillCensus | null>;
}
