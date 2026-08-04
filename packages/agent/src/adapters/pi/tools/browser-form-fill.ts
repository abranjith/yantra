/**
 * `browser_form_fill` — fill an ordered list of fields in one call, re-observing
 * the live page between every step.
 *
 * **Why a second fill tool exists.** `browser_fill` sets one field addressed by
 * an opaque ref from the model's last observation. That is exactly wrong for a
 * multi-field search form, for two compounding reasons seen in run
 * `20260803T033803Z-do-f1d9f01b`:
 *
 *  - The elements that matter often appear only *because of* the previous step.
 *    Autocomplete options and calendar cells do not exist when the model last
 *    observed, so it has no ref for them and cannot obtain one without spending
 *    a turn per field.
 *  - The model-visible observation is capped at 30 elements ranked by viewport
 *    position, so on a real site header links and marketing tiles routinely
 *    outrank the form's own controls.
 *
 * The logged run filled the destination box, then clicked what it believed was
 * the autocomplete suggestion. It was a marketing tile — *"View more deals for
 * Chicago Hotels"*. It never solved the date fields (which are `role: button`
 * opening a calendar widget, not fillable inputs), gave up, and hand-assembled a
 * URL instead. That URL silently returned a different city.
 *
 * So this tool resolves each field against a **fresh, uncapped** observation
 * (`observe({ cap })`, internal only — the model-visible surface is unchanged),
 * dispatches on the resolved element's role so a calendar button is driven as a
 * widget rather than typed into, and can wait for a real `role="option"`
 * suggestion instead of guessing which nearby element was one.
 *
 * **It never submits.** The returned observation includes the submit button, and
 * the model clicks it with `browser_click` — which keeps the protected-action
 * confirmation path (`PROTECTED_ACTION_RE`) exactly where it already was.
 *
 * **It never handles credentials.** There is no `secret_ref` form here; values
 * are plain strings only, and `browser_fill` remains the sole credentialed fill
 * path, so `assertHostBinding`, `withSecret`, and the consent flow are untouched.
 */

import type { AgentBrowserController, AgentInteractable } from '@yantra/core';
import { Type, type Static } from 'typebox';

import type { DomainFailure, DomainResult, ToolWrapperSpec } from '../../../runtime/middleware.js';
import type { RunServices } from '../../../runtime/run-services.js';
import { toCandidateChain } from '../../../runtime/trace.js';

import {
  browserController,
  browserFailure,
  isDomainFailure,
  safeLocatorFor,
} from './browser-common.js';
import { resolveFormField } from './form-field-resolve.js';

/** Interactables resolved for internal matching; never model-visible. */
const RESOLUTION_CAP = 400;

/** How long to wait for an autocomplete suggestion to appear. */
export const SUGGESTION_WAIT_MS = 3_000;

/** Poll interval while waiting for a suggestion. */
const SUGGESTION_POLL_MS = 250;

/** Mirrors `browser-fill.ts`: credential-shaped text may never be a literal. */
const SECRET_SHAPE =
  /(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/;

const BrowserFormFillParams = Type.Object(
  {
    fields: Type.Array(
      Type.Object(
        {
          field: Type.String({
            minLength: 1,
            maxLength: 200,
            description:
              'The field\'s visible name (for example "Where to?" or "Check-in"), or an eNN ref ' +
              'from browser_observe. Names are matched exactly, then by prefix, then by substring.',
          }),
          value: Type.String({
            maxLength: 4096,
            description:
              'The text to enter, the option to pick, or the date to choose. For a date field ' +
              'that opens a calendar, an ISO date such as "2026-08-05" is matched against the ' +
              'rendered day. Never pass a credential here — use browser_fill.',
          }),
          pick_suggestion: Type.Optional(
            Type.Boolean({
              description:
                'Set true for an autocomplete field whose real suggestion must be clicked (a ' +
                'destination box that only accepts a picked place). Waits for a real option to ' +
                'appear and clicks the closest match to "value".',
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 10,
        description: 'Fields to fill, applied in order. Filling stops at the first failure.',
      },
    ),
  },
  { additionalProperties: false },
);
type Params = Static<typeof BrowserFormFillParams>;
type FieldSpec = Params['fields'][number];

/** One field's outcome, returned so the model can see what actually happened. */
interface AppliedField {
  readonly field: string;
  readonly ref: string;
  readonly role: string;
  readonly action: 'filled' | 'picked_suggestion' | 'chose_in_widget';
}

/**
 * Build the multi-field form tool.
 *
 * @param _services Reserved for symmetry with the other tool factories; this
 *   tool takes its services from the per-call context, since every step needs
 *   the live run state rather than a snapshot taken at registration.
 */
export function browserFormFillSpec(
  _services: RunServices,
): ToolWrapperSpec<typeof BrowserFormFillParams> {
  return {
    name: 'browser_form_fill',
    label: 'Browser Form Fill',
    description:
      'Fill several fields of one form in a single call, re-observing the page between each so ' +
      'elements revealed by the previous step (autocomplete suggestions, calendar days) can be ' +
      'used. Address fields by their visible name. Use it for multi-field search forms, ' +
      'autocomplete destination boxes, and date fields that open a calendar. Do NOT use it for ' +
      'a single field (use browser_fill), for credentials (use browser_fill with a secret_ref), ' +
      'or to submit — it never submits; click the submit button with browser_click afterwards.',
    parameters: BrowserFormFillParams,
    sanitizationProfile: 'authenticated',
    mutating: true,
    run: (params: Params, ctx): Promise<DomainResult> => runFormFill(params, ctx.services),
  };
}

async function runFormFill(params: Params, services: RunServices): Promise<DomainResult> {
  const controller = browserController(services);
  if (isDomainFailure(controller)) return controller;

  // Guard every value before touching the page, so a credential-shaped entry
  // anywhere in the list fails the call without partially filling the form.
  for (const spec of params.fields) {
    if (SECRET_SHAPE.test(spec.value)) {
      return {
        ok: false,
        errorCode: 'SECRET_SHAPED_LITERAL',
        message:
          `The value for "${spec.field}" is credential-shaped. browser_form_fill never handles ` +
          'credentials; use browser_fill with a secret_ref.',
        retryable: true,
      };
    }
  }

  const applied: AppliedField[] = [];
  for (const spec of params.fields) {
    const outcome = await applyField(spec, controller, services);
    if (isDomainFailure(outcome)) {
      // Stop at the first failure: never continue past it, and never substitute
      // a guess. The fields already applied are reported so the model can see
      // the partial state rather than re-running the whole form blindly.
      return { ...outcome, details: withApplied(outcome.details, applied) };
    }
    applied.push(outcome);
  }

  // The model-visible (capped) observation, so the agent can see the submit
  // button and click it. Deliberately NOT the uncapped one used internally.
  const observation = await controller.observe();
  return {
    ok: true,
    model: {
      url: observation.url,
      title: observation.title,
      digest: observation.digest,
      interactables: observation.interactables,
      applied,
      note: 'Nothing was submitted. Click the submit/search button with browser_click.',
    },
    details: { fields: applied.length },
  };
}

/** Applies one field against a freshly observed page. */
async function applyField(
  spec: FieldSpec,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<AppliedField | DomainFailure> {
  // Fresh and uncapped every time: the previous step may have revealed the
  // element this one needs, and it is very likely outside the model's cap.
  const observation = await controller.observe({ cap: RESOLUTION_CAP });
  const resolved = resolveFormField(spec.field, observation);
  if (isDomainFailure(resolved)) return resolved;

  switch (resolved.role) {
    case 'textbox':
    case 'searchbox':
    case 'combobox':
      return fillTextual(spec, resolved, controller, services);
    case 'button':
      return chooseInWidget(spec, resolved, controller, services);
    case 'checkbox':
    case 'radio':
      return {
        ok: false,
        errorCode: 'FORM_FIELD_UNSUPPORTED_ROLE',
        message:
          `"${spec.field}" is a ${resolved.role}, which browser_form_fill does not set. Use ` +
          'browser_click to toggle it.',
        retryable: true,
      };
    default:
      return {
        ok: false,
        errorCode: 'FORM_FIELD_UNSUPPORTED_ROLE',
        message:
          `"${spec.field}" resolved to a ${resolved.role}, which is not a fillable form field. ` +
          'Use browser_click to activate it.',
        retryable: true,
      };
  }
}

/**
 * Types into a text-like field. A native `<select>` routes through the
 * controller's own `fillSelect`, so `OPTION_NOT_FOUND` surfaces unchanged.
 */
async function fillTextual(
  spec: FieldSpec,
  target: AgentInteractable,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<AppliedField | DomainFailure> {
  const described = controller.describeRef(target.ref);
  const host = controller.host();
  const ranked = await safeLocatorFor(controller, target.ref);
  try {
    await controller.fill(target.ref, spec.value);
  } catch (error) {
    return browserFailure(error);
  }
  services.trace?.append({
    kind: 'fill',
    host,
    locator:
      ranked.length > 0 ? ranked : toCandidateChain(described?.role ?? target.role, target.name),
    // The trace is a long-lived, promotable artifact: record the masked
    // (placeholder) form, exactly as browser-fill.ts does.
    value: { kind: 'literal', value: services.userInput?.mask(spec.value) ?? spec.value },
    submit: false,
    requires_confirmation: false,
  });

  if (spec.pick_suggestion !== true) {
    return { field: spec.field, ref: target.ref, role: target.role, action: 'filled' };
  }
  return pickSuggestion(spec, target, controller, services);
}

/**
 * Waits for a real `role="option"` suggestion and clicks the closest match.
 *
 * The wait is the point: suggestions arrive asynchronously, and the logged run
 * failed precisely because it acted on whatever was already on screen. Only
 * elements the page itself marks as options are eligible, so a same-named
 * marketing tile can never win.
 */
async function pickSuggestion(
  spec: FieldSpec,
  target: AgentInteractable,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<AppliedField | DomainFailure> {
  const deadline = services.now() + SUGGESTION_WAIT_MS;
  let options: AgentInteractable[];
  for (;;) {
    const observation = await controller.observe({ cap: RESOLUTION_CAP });
    options = observation.interactables.filter((entry) => entry.role === 'option');
    if (options.length > 0) break;
    if (services.now() >= deadline) {
      return {
        ok: false,
        errorCode: 'SUGGESTION_NOT_OFFERED',
        message:
          `"${spec.field}" was filled with "${spec.value}", but no autocomplete suggestion ` +
          `appeared within ${SUGGESTION_WAIT_MS} ms. Re-observe and continue without a ` +
          'suggestion, or use browser_click on the intended result.',
        retryable: true,
      };
    }
    await sleep(SUGGESTION_POLL_MS);
  }

  const choice = bestNameMatch(options, spec.value);
  if (choice === null) {
    return {
      ok: false,
      errorCode: 'SUGGESTION_NOT_OFFERED',
      message:
        `No suggestion for "${spec.field}" matches "${spec.value}". Offered: ` +
        `${options.map((entry) => `"${entry.name}"`).join(', ')}.`,
      retryable: true,
    };
  }
  const clicked = await clickCandidate(choice, controller, services);
  if (clicked !== null) return clicked;
  return { field: spec.field, ref: choice.ref, role: target.role, action: 'picked_suggestion' };
}

/**
 * Drives a field that is a button opening a widget — kayak's check-in/check-out
 * dates are `role: button`, not fillable inputs, which is why the logged run
 * never solved them. Click to open, re-observe, then click the day.
 */
async function chooseInWidget(
  spec: FieldSpec,
  target: AgentInteractable,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<AppliedField | DomainFailure> {
  const opened = await clickCandidate(target, controller, services);
  if (opened !== null) return opened;

  const observation = await controller.observe({ cap: RESOLUTION_CAP });
  const choice = bestNameMatch(observation.interactables, spec.value);
  if (choice === null) {
    return {
      ok: false,
      errorCode: 'FORM_WIDGET_NO_MATCH',
      message:
        `Opened "${spec.field}" but nothing in it matches "${spec.value}". Visible choices: ` +
        `${describeNames(observation.interactables)}.`,
      retryable: true,
    };
  }
  const clicked = await clickCandidate(choice, controller, services);
  if (clicked !== null) return clicked;
  return { field: spec.field, ref: choice.ref, role: target.role, action: 'chose_in_widget' };
}

/** Clicks a candidate and traces it; returns a failure, or `null` on success. */
async function clickCandidate(
  candidate: AgentInteractable,
  controller: AgentBrowserController,
  services: RunServices,
): Promise<DomainFailure | null> {
  const host = controller.host();
  const ranked = await safeLocatorFor(controller, candidate.ref);
  try {
    await controller.click(candidate.ref);
  } catch (error) {
    return browserFailure(error);
  }
  services.trace?.append({
    kind: 'click',
    host,
    locator: ranked.length > 0 ? ranked : toCandidateChain(candidate.role, candidate.name),
    requires_confirmation: false,
  });
  return null;
}

/**
 * Picks the candidate whose name best matches `value`.
 *
 * Exact (case-insensitive) wins. Otherwise, when `value` is an ISO date, the
 * rendered US long form is tried (kayak renders `"August 5, 2026"`), then a
 * loose match requiring both the month name and the day number — enough to
 * identify a calendar cell without matching a neighbouring day.
 */
export function bestNameMatch(
  candidates: readonly AgentInteractable[],
  value: string,
): AgentInteractable | null {
  const named = candidates.filter((entry) => entry.name.trim().length > 0);
  const wanted = value.trim().toLowerCase();

  const exact = named.find((entry) => entry.name.trim().toLowerCase() === wanted);
  if (exact !== undefined) return exact;

  const date = parseIsoDate(value);
  if (date !== null) {
    const rendered = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    })
      .format(date)
      .toLowerCase();
    const renderedMatch = named.find((entry) => entry.name.trim().toLowerCase() === rendered);
    if (renderedMatch !== undefined) return renderedMatch;

    const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' })
      .format(date)
      .toLowerCase();
    const day = String(date.getUTCDate());
    const dayPattern = new RegExp(`\\b${day}\\b`);
    const loose = named.filter((entry) => {
      const name = entry.name.toLowerCase();
      return name.includes(month) && dayPattern.test(name);
    });
    if (loose.length === 1) return loose[0]!;
  }

  const prefix = named.filter((entry) => entry.name.trim().toLowerCase().startsWith(wanted));
  if (prefix.length === 1) return prefix[0]!;
  const substring = named.filter((entry) => entry.name.trim().toLowerCase().includes(wanted));
  if (substring.length === 1) return substring[0]!;
  return null;
}

/** Parses `YYYY-MM-DD` as a UTC date, or `null` when the value is not one. */
function parseIsoDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // Rejects impossible dates that Date would roll over (2026-02-31).
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return date;
}

/** Renders up to 8 candidate names for an error message. */
function describeNames(candidates: readonly AgentInteractable[]): string {
  const named = candidates.filter((entry) => entry.name.trim().length > 0);
  if (named.length === 0) return '(none)';
  const names = named.slice(0, 8).map((entry) => `"${entry.name.trim()}"`);
  const extra = named.length - names.length;
  return extra > 0 ? `${names.join(', ')} (+${extra} more)` : names.join(', ');
}

/** Attaches the applied-so-far summary to a failure's `details`. */
function withApplied(prior: unknown, applied: readonly AppliedField[]): Record<string, unknown> {
  const base =
    typeof prior === 'object' && prior !== null && !Array.isArray(prior)
      ? (prior as Record<string, unknown>)
      : {};
  return { ...base, applied };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
