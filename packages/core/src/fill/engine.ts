import type { AgentInteractable } from '../browser/agent-controller.js';
import { calendarDriver } from '../widgets/date/calendar-driver.js';
import { dateInputDriver } from '../widgets/date/date-input-driver.js';
import { resolveDatePair } from '../widgets/date/date-pair.js';
import { resolveContainer } from '../widgets/open-state.js';
import { listboxDriver } from '../widgets/option/listbox-driver.js';
import { nativeSelectDriver } from '../widgets/option/native-select-driver.js';
import {
  defaultWidgetBudget,
  type WidgetFailure,
  type WidgetIntent,
  type WidgetPort,
  type WidgetTarget,
} from '../widgets/types.js';
import { matchesIntent, readCommitted } from '../widgets/verify.js';

import { dismissWidget } from './dismiss.js';
import { watchAndSelect } from './react.js';
import {
  fillFailure,
  type FieldIdentity,
  type FillBudget,
  type FillFailure,
  type FillIntent,
  type FillOutcome,
} from './types.js';

const REF_PATTERN = /^e[0-9]+$/;

/**
 * Deterministically fill one named control, verify its committed value, and
 * release any floating widget it opened.
 */
export async function fillField(
  port: WidgetPort,
  identity: FieldIdentity,
  intent: FillIntent,
  budget: FillBudget = defaultWidgetBudget(port),
): Promise<FillOutcome> {
  const healed = fieldHealingPort(port, identity);
  const target = healed.target;
  let driver: string;
  let committed: string;
  let actions = 0;
  let reactionDismissed = false;

  try {
    const shape = await healed.port.evaluateOn(target.ref, (element) => {
      const tag = element.tagName.toLowerCase();
      const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : '';
      const role = element.getAttribute('role')?.toLowerCase() ?? '';
      const hint =
        element instanceof HTMLInputElement
          ? `${element.placeholder} ${element.pattern} ${element.getAttribute('aria-label') ?? ''}`
          : '';
      return {
        tag,
        type,
        role,
        dateHint: type === 'date' || /(?:yyyy|mm|dd|\bdate\b)/i.test(hint),
        textLike:
          element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLInputElement &&
            !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)),
        linkedPopup:
          element.hasAttribute('aria-controls') ||
          element.hasAttribute('aria-owns') ||
          element.hasAttribute('aria-haspopup') ||
          element.hasAttribute('aria-autocomplete'),
      };
    });
    const ignoredContainer = shape.linkedPopup
      ? null
      : await resolveContainer(healed.port, target, { allowUnlinked: true });

    if (intent.kind === 'secret') {
      return fillFailure(
        'FILL_VALUE_INVALID',
        'Secret intents must be resolved at the execution boundary and passed to fillField as text with secret verification disabled.',
        { key: intent.key },
        false,
      );
    }

    if (intent.kind === 'toggle') {
      const current = await readChecked(healed.port, target);
      if (current !== intent.checked) {
        await healed.port.click(target.ref);
        actions += 1;
      }
      const checked = await readChecked(healed.port, target);
      if (checked !== intent.checked) {
        return fillFailure(
          'WIDGET_NOT_COMMITTED',
          `The ${target.role} "${target.name}" did not commit the requested checked state.`,
          { checked },
        );
      }
      driver = 'toggle';
      committed = checked ? 'checked' : 'unchecked';
    } else if (shape.tag === 'select') {
      const optionIntent = asOptionIntent(intent);
      if (!optionIntent) return incompatible(target, intent);
      const outcome = await nativeSelectDriver.drive(healed.port, target, optionIntent, budget);
      if (!outcome.ok) return fromWidgetFailure(outcome);
      ({ driver, committed, actions } = outcome);
    } else if (
      (intent.kind === 'date' || intent.kind === 'date_range') &&
      shape.tag === 'input' &&
      shape.dateHint
    ) {
      const outcome = await dateInputDriver.drive(healed.port, target, intent, budget);
      if (!outcome.ok) return fromWidgetFailure(outcome);
      ({ driver, committed, actions } = outcome);
    } else if (intent.kind === 'date' || intent.kind === 'date_range') {
      const outcome = await calendarDriver.drive(healed.port, target, intent, budget);
      if (!outcome.ok) return fromWidgetFailure(outcome);
      ({ driver, committed, actions } = outcome);
    } else if (!shape.textLike && intent.kind === 'option') {
      const outcome = await listboxDriver.drive(healed.port, target, intent, budget);
      if (!outcome.ok) return fromWidgetFailure(outcome);
      ({ driver, committed, actions } = outcome);
    } else if ((intent.kind === 'text' || intent.kind === 'option') && shape.textLike) {
      const text = intent.kind === 'text' ? intent.text : intent.value;
      await healed.port.fill(target.ref, text);
      actions += 1;
      const reacted = await watchAndSelect(healed.port, target, text, budget, ignoredContainer);
      if (!reacted.ok) return reacted;
      actions += reacted.actions;
      committed = reacted.committed;
      reactionDismissed = reacted.dismissed;
      driver = reacted.selected ? 'typeahead' : 'plain-text';
    } else {
      return incompatible(target, intent);
    }

    // Release before the authoritative verification, not after. A picker that
    // commits on release reports its old value until it closes, and a range
    // spread over a check-in/check-out pair cannot be read while the popup's
    // duplicate copy of that pair is still on the page.
    const dismissed = await dismissWidget(
      healed.port,
      target,
      committed,
      (value) => matchesFillIntent(value, intent),
      ignoredContainer,
    );
    if (!dismissed.ok) return dismissed;
    const settled = await settledCommit(healed.port, target, intent, dismissed.committed);
    if (settled === null) {
      return fillFailure(
        'WIDGET_NOT_COMMITTED',
        `The "${target.name}" control does not reflect the requested value.`,
        { committed: dismissed.committed },
      );
    }
    return {
      ok: true,
      driver,
      committed: settled,
      actions: actions + dismissed.actions,
      dismissed: reactionDismissed || dismissed.dismissed,
    };
  } catch (error) {
    if (isStaleRefError(error)) {
      return fillFailure(
        'WIDGET_ELEMENT_REPLACED',
        `The page replaced the "${identity.target.name}" control and it could not be found again.`,
        { field: identity.field, name: identity.target.name, role: identity.target.role },
      );
    }
    throw error;
  }
}

/**
 * Commit a resolved secret through the plain-text controller path without
 * reading it back or exposing it to suggestion discovery. The caller owns the
 * secret buffer and must dispose it immediately after this promise settles.
 */
export async function fillSecretField(
  port: WidgetPort,
  identity: FieldIdentity,
  secretValue: string,
  budget: FillBudget = defaultWidgetBudget(port),
): Promise<FillOutcome> {
  if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
    return fillFailure(
      'WIDGET_TARGET_UNREACHABLE',
      'The fill action budget was exhausted before the secret could be committed.',
      { reason: 'budget' },
    );
  }
  const healed = fieldHealingPort(port, identity);
  try {
    await healed.port.fill(healed.target.ref, secretValue);
    return {
      ok: true,
      driver: 'plain-text',
      committed: '',
      actions: 1,
      dismissed: false,
    };
  } catch (error) {
    if (isStaleRefError(error)) {
      return fillFailure(
        'WIDGET_ELEMENT_REPLACED',
        `The page replaced the "${identity.target.name}" control and it could not be found again.`,
        { field: identity.field, name: identity.target.name, role: identity.target.role },
      );
    }
    throw error;
  }
}

/** Compare a committed page value with a semantic fill intent. */
export function matchesFillIntent(committed: string, intent: FillIntent): boolean {
  const actual = normalize(committed);
  switch (intent.kind) {
    case 'text':
      return actual === normalize(intent.text) || actual.includes(normalize(intent.text));
    case 'option':
      return (
        actual.length > 0 &&
        normalize(intent.value).length > 0 &&
        (actual.includes(normalize(intent.value)) || normalize(intent.value).includes(actual))
      );
    case 'toggle':
      return actual === (intent.checked ? 'checked' : 'unchecked');
    // Dates share the driver-level matcher rather than carrying a second
    // implementation. That one tolerates a widget that renders no year — the
    // common compact form ("Sun, Sep 6") — and matches a range's endpoints in
    // order, both of which a stricter local copy reported as uncommitted.
    case 'date':
    case 'date_range':
      return matchesIntent(committed, intent);
    case 'secret':
      return true;
  }
}

/**
 * The committed text that satisfies the intent once the widget has settled, or
 * null when it never landed.
 *
 * A range the page spreads over a check-in/check-out pair fills each side
 * separately, so the control that opened the calendar holds only its own
 * endpoint and reading it alone would call a correct selection uncommitted.
 * The pair is consulted only after the direct read fails, and only when exactly
 * one control matches each side — an ambiguous page is never guessed at.
 */
async function settledCommit(
  port: WidgetPort,
  target: WidgetTarget,
  intent: FillIntent,
  committed: string,
): Promise<string | null> {
  if (matchesFillIntent(committed, intent)) return committed;
  if (intent.kind !== 'date_range') return null;
  const pair = await resolveDatePair(port, target);
  if (!pair) return null;
  const from = await readCommitted(port, pair.from);
  const to = await readCommitted(port, pair.to);
  const landed =
    matchesIntent(from, { kind: 'date', date: intent.from }) &&
    matchesIntent(to, { kind: 'date', date: intent.to });
  return landed ? `${from}..${to}` : null;
}

function asOptionIntent(intent: FillIntent): WidgetIntent | null {
  if (intent.kind === 'option') return intent;
  if (intent.kind === 'text') return { kind: 'option', value: intent.text };
  return null;
}

function incompatible(target: WidgetTarget, intent: FillIntent): FillFailure {
  return fillFailure(
    'WIDGET_TARGET_UNREACHABLE',
    `The ${target.role} "${target.name}" cannot accept a ${intent.kind} fill intent.`,
    { role: target.role, intent: intent.kind },
  );
}

function fromWidgetFailure(failure: WidgetFailure): FillFailure {
  if (failure.errorCode === 'WIDGET_NOT_RECOGNIZED') {
    return fillFailure('WIDGET_TARGET_UNREACHABLE', failure.message, failure.details);
  }
  return fillFailure(failure.errorCode, failure.message, failure.details, failure.retryable);
}

async function readChecked(port: WidgetPort, target: WidgetTarget): Promise<boolean> {
  return port.evaluateOn(target.ref, (element) => {
    if (element instanceof HTMLInputElement) return element.checked;
    return element.getAttribute('aria-checked') === 'true';
  });
}

function fieldHealingPort(
  port: WidgetPort,
  identity: FieldIdentity,
): { readonly port: WidgetPort; readonly target: WidgetTarget } {
  let current = identity.target;
  let reacquired = false;
  const owns = (ref: string): boolean => ref === identity.target.ref || ref === current.ref;
  const run = async <T>(ref: string, operation: (liveRef: string) => Promise<T>): Promise<T> => {
    const effective = owns(ref) ? current.ref : ref;
    try {
      return await operation(effective);
    } catch (error) {
      if (!isStaleRefError(error) || !owns(ref) || reacquired) throw error;
      reacquired = true;
      const next = await reacquireTarget(port, identity);
      if (!next) throw error;
      current = next;
      return operation(current.ref);
    }
  };
  const adapted: WidgetPort = {
    observe: (options) => port.observe(options),
    click: (ref) => run(ref, (liveRef) => port.click(liveRef)),
    fill: (ref, value) => run(ref, (liveRef) => port.fill(liveRef, value)),
    evaluateOn: (ref, fn, ...args) => run(ref, (liveRef) => port.evaluateOn(liveRef, fn, ...args)),
    evaluate: (fn, ...args) => port.evaluate(fn, ...args),
    press: (key) => port.press(key),
    now: () => port.now(),
  };
  // Drivers keep the original target object. The adapted port maps that ref to
  // the current one after the single stronger field-string re-acquisition.
  return { port: adapted, target: identity.target };
}

async function reacquireTarget(
  port: WidgetPort,
  identity: FieldIdentity,
): Promise<WidgetTarget | null> {
  const observation = await port.observe({ cap: 400, trackDigest: false });
  const queries = [identity.field, identity.target.name, identity.target.name.split(',')[0] ?? '']
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  for (const query of queries) {
    const match = resolveField(query, observation.interactables);
    if (match) return toTarget(match);
  }
  return null;
}

function resolveField(
  field: string,
  interactables: readonly AgentInteractable[],
): AgentInteractable | null {
  if (REF_PATTERN.test(field)) {
    return interactables.find((entry) => entry.ref === field) ?? null;
  }
  const wanted = normalize(field);
  const named = interactables.filter((entry) => entry.name.trim().length > 0);
  const tiers = [
    named.filter((entry) => normalize(entry.name) === wanted),
    named.filter((entry) => normalize(entry.name).startsWith(wanted)),
    named.filter((entry) => normalize(entry.name).includes(wanted)),
  ];
  const winner = tiers.find((tier) => tier.length > 0);
  return winner?.length === 1 ? winner[0]! : null;
}

function toTarget(entry: AgentInteractable): WidgetTarget {
  return {
    ref: entry.ref,
    role: entry.role,
    name: entry.name,
    group: entry.group ?? null,
    value: entry.value ?? null,
  };
}

function isStaleRefError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'STALE_ELEMENT_REF'
  );
}

function normalize(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
