import {
  FAILURE_TEMPLATES,
  DanglingHintError,
  type FillCause,
  type FillErrorCode,
  type FailureTemplateTable,
} from '../fill/types.js';

import type { InteractionFamily } from './escalation.js';

export type InteractionMessageSurface =
  | 'fill'
  | 'actionability'
  | 'success-note'
  | 'tool'
  | 'middleware';
export type MessageCapabilityKind = 'engine' | 'tool' | null;

/** One catalog-owned model-visible interaction message. */
export interface MessageTemplate {
  readonly surface: InteractionMessageSurface;
  readonly code: string;
  readonly cause: string;
  readonly message: (details: Readonly<Record<string, unknown>>) => string;
  readonly hint: (details: Readonly<Record<string, unknown>>) => string;
  readonly requiredDetails: readonly string[];
  readonly capability: string | null;
  readonly capabilityKind: MessageCapabilityKind;
  readonly emittedBy?: readonly InteractionFamily[];
}

export class DanglingInteractionMessageError extends Error {
  public constructor(
    public readonly key: string,
    public readonly missing: readonly string[],
  ) {
    super(`The interaction message ${key} requires missing detail keys: ${missing.join(', ')}.`);
    this.name = 'DanglingInteractionMessageError';
  }
}

const failureTemplates: FailureTemplateTable = FAILURE_TEMPLATES;
const fillMessages: readonly MessageTemplate[] = Object.entries(failureTemplates).flatMap(
  ([code, causes]) =>
    Object.entries(causes).map(([cause, template]) => ({
      surface: template.surface,
      code,
      cause,
      message: (details: Readonly<Record<string, unknown>>) =>
        `${code} (${cause}): ${template.hint(details)}`,
      hint: template.hint,
      requiredDetails: template.requiredDetails,
      capability: template.capability,
      capabilityKind: template.capabilityKind,
      ...(template.emittedBy === undefined ? {} : { emittedBy: template.emittedBy }),
    })),
);

/**
 * The details every `ELEMENT_OBSTRUCTED` template reads.
 *
 * `kind` is required and total over the four registrations, so an unclassified
 * obstruction is a lookup failure rather than a generic fallback sentence.
 */
const OBSTRUCTION_REQUIRED_DETAILS = [
  'kind',
  'obstruction',
  'clearance_attempted',
  'candidates',
] as const;

const actionabilityMessages = [
  {
    surface: 'actionability',
    code: 'STALE_ELEMENT_REF',
    cause: 'stale-ref',
    message: (details) => {
      const ref = quoted(details, 'ref');
      const reason = primitive(details.reason);
      return reason
        ? `Element ref ${ref} is stale: ${reason}.`
        : `Element ref ${ref} is stale or unknown. Use the fresh observation returned by the latest action, or call browser_observe for a new read before acting.`;
    },
    hint: () => 'Use the latest returned observation, or call browser_observe before acting.',
    requiredDetails: ['ref'],
    capability: null,
    capabilityKind: null,
  },
  {
    surface: 'actionability',
    code: 'ELEMENT_HIDDEN',
    cause: 'hidden',
    message: () => 'The observed element is no longer visible. Re-observe the page.',
    hint: () => 'Re-observe the page.',
    requiredDetails: [],
    capability: null,
    capabilityKind: null,
  },
  {
    surface: 'actionability',
    code: 'ELEMENT_DISABLED',
    cause: 'disabled',
    message: () =>
      'The observed element is disabled. Disabled elements are marked disabled: true in the observation; choose a different element.',
    hint: () => 'Choose an enabled element from the observation.',
    requiredDetails: [],
    capability: null,
    capabilityKind: null,
  },
  {
    surface: 'actionability',
    code: 'OPTION_NOT_FOUND',
    cause: 'option-not-found',
    message: () =>
      'No option in the observed dropdown matches the supplied value. Use an option label or value exactly as observed.',
    hint: () => 'Use an observed option label or value exactly.',
    requiredDetails: [],
    capability: 'selectByOfferedLabel',
    capabilityKind: 'engine',
    emittedBy: ['option'],
  },
  obstructed('obstructed-by-modal', 'A modal dialog'),
  obstructed('obstructed-by-fixed-overlay', 'A viewport-pinned fixed or sticky overlay'),
  obstructed('obstructed-by-plain-overlay', 'A stacked overlay in the page flow'),
  {
    surface: 'actionability',
    code: 'ELEMENT_OBSTRUCTED',
    cause: 'obstructed-by-busy-indicator',
    // The one kind with no capability: the advice is to wait and re-issue, not
    // to act on something. A busy indicator is transient and is never dismissed.
    message: (details) =>
      sentences([
        "A busy indicator is covering this element's click point, so the action would land on the indicator instead of the control.",
        overlaySentence(details),
        'A busy indicator is never dismissed automatically. Let the page finish settling, then re-issue the same call.',
      ]),
    hint: () => 'Wait for the page to finish settling and re-issue the same call.',
    requiredDetails: OBSTRUCTION_REQUIRED_DETAILS,
    capability: null,
    capabilityKind: null,
  },
] as const satisfies readonly MessageTemplate[];

const successMessages = [
  success(
    'structural_tie_break',
    (details) =>
      `${quoted(details, 'field')} exposed ${Number(details.count)} indistinguishable choices named ${quoted(details, 'label')}; Yantra chose the first in document order and disclosed that substitution.`,
    ['field', 'count', 'label'],
  ),
  success(
    'single_offered_match',
    (details) =>
      `${quoted(details, 'field')} offered one match for ${quoted(details, 'requested')} and committed ${quoted(details, 'committed')}; that is the widget resolving your value, not a failure.`,
  ),
  success(
    'selected_from_offered',
    (details) =>
      `${quoted(details, 'field')} offered ${Number(details.offeredCount)} matches for ${quoted(details, 'requested')} and committed ${quoted(details, 'committed')}; that is the widget resolving your value, not a failure.`,
    ['field', 'requested', 'committed', 'offeredCount'],
  ),
  success(
    'reformatted',
    (details) =>
      `${quoted(details, 'field')} reformatted ${quoted(details, 'requested')} to ${quoted(details, 'committed')} and accepted it.`,
  ),
  success(
    'typed_literal',
    (details) =>
      `${quoted(details, 'field')} offered no matching suggestion, so the typed text ${quoted(details, 'committed')} stands as the value.`,
    ['field', 'committed'],
  ),
];

export const INTERACTION_MESSAGES: readonly MessageTemplate[] = [
  ...fillMessages,
  ...actionabilityMessages,
  ...successMessages,
];

export function interactionMessage(
  surface: MessageTemplate['surface'],
  code: string,
  cause: string,
): MessageTemplate {
  const found = INTERACTION_MESSAGES.find(
    (entry) => entry.surface === surface && entry.code === code && entry.cause === cause,
  );
  if (!found)
    throw new DanglingInteractionMessageError(`${surface}/${code}/${cause}`, ['template']);
  return found;
}

export function renderInteractionMessage(
  surface: MessageTemplate['surface'],
  code: string,
  cause: string,
  details: Readonly<Record<string, unknown>>,
): { readonly message: string; readonly hint: string } {
  const template = interactionMessage(surface, code, cause);
  const missing = template.requiredDetails.filter(
    (key) => details[key] === undefined || details[key] === null,
  );
  if (missing.length > 0) {
    if (surface === 'fill')
      throw new DanglingHintError(code as FillErrorCode, cause as FillCause, missing);
    throw new DanglingInteractionMessageError(`${surface}/${code}/${cause}`, missing);
  }
  return { message: template.message(details), hint: template.hint(details) };
}

function success(
  cause: string,
  message: MessageTemplate['message'],
  requiredDetails: readonly string[] = ['field', 'requested', 'committed'],
): MessageTemplate {
  return {
    surface: 'success-note',
    code: 'FILL_SUCCESS_NOTE',
    cause,
    message,
    hint: () => 'Continue from the committed value.',
    requiredDetails,
    capability: null,
    capabilityKind: null,
  };
}

/**
 * One terminal obstruction template.
 *
 * `lead` is baked into the closure rather than read from `details.kind` so the
 * four registrations stay textually distinct under the catalog's distinctness
 * invariant even when rendered from the same payload.
 */
function obstructed(cause: string, lead: string): MessageTemplate {
  return {
    surface: 'actionability',
    code: 'ELEMENT_OBSTRUCTED',
    cause,
    message: (details) =>
      sentences([
        `${lead} is covering this element's click point, so the action would land on the overlay instead of the control.`,
        overlaySentence(details),
        clearanceSentence(details),
        candidateSentence(details),
      ]),
    hint: (details) => candidateSentence(details),
    requiredDetails: OBSTRUCTION_REQUIRED_DETAILS,
    // Legal under the engineered-capability rule only because the offered
    // candidates are refs this controller can resolve and browser_click is in
    // the active catalog; a test asserts both.
    capability: 'browser_click',
    capabilityKind: 'tool',
  };
}

function overlaySentence(details: Readonly<Record<string, unknown>>): string {
  const overlay = details.obstruction;
  if (typeof overlay !== 'object' || overlay === null) return '';
  const { role, name } = overlay as { readonly role?: unknown; readonly name?: unknown };
  const roleText = primitive(role);
  const nameText = primitive(name);
  if (nameText.length === 0) {
    return roleText.length === 0 ? '' : `The overlay reports role ${JSON.stringify(roleText)}.`;
  }
  return `The overlay reports itself as ${roleText.length === 0 ? 'an unnamed container' : roleText} ${JSON.stringify(nameText)}.`;
}

function clearanceSentence(details: Readonly<Record<string, unknown>>): string {
  if (details.clearance_attempted === true) {
    return details.clearance_result === 'different-obstruction'
      ? 'One dismiss control inside it was already pressed, and a different overlay now covers the same point; the engine presses at most one per tool call.'
      : 'One dismiss control inside it was already pressed and the point is still covered; the engine presses at most one per tool call.';
  }
  switch (details.clearance_skipped) {
    case 'no-eligible-candidate':
      return 'Nothing inside it is an unambiguous dismissal, so nothing was pressed on your behalf.';
    case 'already-spent-this-call':
      return 'This tool call already spent its one automatic dismissal, so nothing was pressed.';
    default:
      return '';
  }
}

function candidateSentence(details: Readonly<Record<string, unknown>>): string {
  const candidates = Array.isArray(details.candidates) ? details.candidates : [];
  const listed = candidates
    .filter(
      (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
    )
    .map((entry) => {
      const ref = primitive(entry.ref);
      const name = primitive(entry.name);
      const guarded = entry.protected === true ? ' — needs your confirmation' : '';
      return `${ref} (${JSON.stringify(name)}${guarded})`;
    });
  if (listed.length === 0) {
    return 'No dismiss control was found inside it. Call browser_observe for a fresh read and act on a control that is not underneath it.';
  }
  const truncated = details.candidates_truncated === true ? ', and there are more' : '';
  return `Dismiss it with browser_click on one of these refs from inside it: ${listed.join(', ')}${truncated}. Then re-issue this call.`;
}

/** Join non-empty sentence fragments with a single space. */
function sentences(parts: readonly string[]): string {
  return parts.filter((part) => part.length > 0).join(' ');
}

function primitive(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : '';
}

function quoted(details: Readonly<Record<string, unknown>>, key: string): string {
  return `"${primitive(details[key])}"`;
}
