import type { AgentInteractable } from '../browser/agent-controller.js';
import { calendarDriver } from '../widgets/date/calendar-driver.js';
import { dateInputDriver } from '../widgets/date/date-input-driver.js';
import { pendingRangePartner, resolveDatePair } from '../widgets/date/date-pair.js';
import { resolveContainer } from '../widgets/open-state.js';
import { listboxDriver } from '../widgets/option/listbox-driver.js';
import { nativeSelectDriver } from '../widgets/option/native-select-driver.js';
import {
  defaultWidgetBudget,
  type WidgetContainer,
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
  const entry = await rangeEntryPoint(port, identity, intent);
  const healed = fieldHealingPort(port, entry);
  const target = healed.target;
  let driver: string;
  let committed: string;
  let actions = 0;
  let reactionDismissed = false;
  let driven: WidgetContainer | null = null;

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
      driven = outcome.container ?? null;
    } else if (!shape.textLike && intent.kind === 'option') {
      const outcome = await listboxDriver.drive(healed.port, target, intent, budget);
      if (!outcome.ok) return fromWidgetFailure(outcome);
      ({ driver, committed, actions } = outcome);
      driven = outcome.container ?? null;
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

    // Whether the widget is holding half a range at the moment of release. This
    // is recorded as a fact before anything is released and consulted only if
    // the release then fails, so a page that does commit a one-sided range is
    // unaffected — see rangeIncomplete.
    const pendingPartner =
      intent.kind === 'date' && matchesFillIntent(committed, intent)
        ? await pendingRangePartner(healed.port, target)
        : null;

    // Release before the authoritative verification, not after. A picker that
    // commits on release reports its old value until it closes, and a range
    // spread over a check-in/check-out pair cannot be read while the popup's
    // duplicate copy of that pair is still on the page.
    const dismissed = await dismissWidget(
      healed.port,
      target,
      committed,
      (value) => matchesFillIntent(value, intent),
      { ignoredContainer, driven },
    );
    if (!dismissed.ok) return rangeIncomplete(target, intent, pendingPartner) ?? dismissed;
    const settled = await settledCommit(healed.port, target, intent, dismissed.committed);
    if (settled === null) {
      return (
        rangeIncomplete(target, intent, pendingPartner) ??
        fillFailure(
          'WIDGET_NOT_COMMITTED',
          `The "${target.name}" control does not reflect the requested value.`,
          { committed: dismissed.committed },
        )
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
        `The page replaced the "${entry.target.name}" control and it could not be found again.`,
        { field: entry.field, name: entry.target.name, role: entry.target.role },
      );
    }
    throw error;
  }
}

/**
 * The control a range has to be driven from.
 *
 * A picker that spreads a range over two controls asks for the ends in order:
 * opened from the start field it takes a start and then an end, opened from the
 * end field it takes an end and then reads the next click as the beginning of a
 * fresh range. A range addressed to the closing field therefore selects the
 * right two days and still commits nothing — the widget was answering a
 * different question, and the whole selection is discarded on release. Which
 * end a control is comes from the page's own labelling, and the pair is
 * accepted only when exactly one control matches each side, so re-pointing the
 * drive is not a choice between candidate fields.
 *
 * Everything else is returned untouched: a single date, a page with no such
 * pair, and a range already addressed to the opening field.
 */
async function rangeEntryPoint(
  port: WidgetPort,
  identity: FieldIdentity,
  intent: FillIntent,
): Promise<FieldIdentity> {
  if (intent.kind !== 'date_range') return identity;
  const pair = await resolveDatePair(port, identity.target);
  if (!pair) return identity;
  const named = identity.target.name.trim().toLocaleLowerCase();
  const addressesEnd =
    identity.target.ref === pair.to.ref || pair.to.name.trim().toLocaleLowerCase() === named;
  if (!addressesEnd) return identity;
  return { field: pair.from.name, target: pair.from };
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
  // Releasing the widget is what makes a paired range readable, and the second
  // field is frequently written a beat after the first as the page settles. A
  // single read therefore races the page and can call a landed range
  // uncommitted — which costs the caller a retry of work that already
  // succeeded, or pushes it into finishing the job by hand. Only the
  // already-failing path pays for the poll.
  const deadline = port.now() + COMMIT_SETTLE_MS;
  for (;;) {
    const pair = await resolveDatePair(port, target);
    if (pair) {
      const from = await readCommitted(port, pair.from);
      const to = await readCommitted(port, pair.to);
      if (
        matchesIntent(from, { kind: 'date', date: intent.from }) &&
        matchesIntent(to, { kind: 'date', date: intent.to })
      ) {
        return `${from}..${to}`;
      }
    }
    if (port.now() >= deadline) return null;
    await sleep(COMMIT_SETTLE_POLL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-label a lost single-date fill as the pair problem it actually is.
 *
 * The picker took the date — it was showing it when the release began — and the
 * page still ended up without it. On a widget that spreads one range over two
 * controls with the other end left blank, that is not a rejected date, an
 * uncooperative overlay, or anything a retry of the same call can change: the
 * commit unit is the pair, so half of one is discarded on release and the
 * previous range comes back. Saying that, and naming the call that works, is
 * the difference between one more call and a caller that abandons the tool and
 * starts clicking day cells itself.
 *
 * Returns null unless that exact state was observed, leaving every other
 * failure to report itself.
 */
function rangeIncomplete(
  target: WidgetTarget,
  intent: FillIntent,
  partner: WidgetTarget | null,
): FillFailure | null {
  if (!partner || intent.kind !== 'date') return null;
  return fillFailure(
    'WIDGET_RANGE_INCOMPLETE',
    `"${target.name}" is one end of a date range that this picker commits together with "${partner.name}", so setting it on its own was discarded and the page is unchanged. Send both ends in one call: "${target.name}" with the value "${intent.date}..<${partner.name} date>", or both fields in one browser_fill_form.`,
    { field: target.name, partner: partner.name, requested: intent.date },
  );
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

/**
 * How many times one drive may re-acquire a target the page replaced.
 *
 * Opening a widget is itself a re-render on many sites, and a range fill then
 * clicks twice more, so a single allowance runs out before the first date
 * lands. The bound exists to stop a loop, not to ration recovery.
 */
const MAX_REACQUISITIONS = 4;

/** How long a released widget is given to finish writing a paired range. */
const COMMIT_SETTLE_MS = 1_000;
/** Polling cadence while waiting for that write. */
const COMMIT_SETTLE_POLL_MS = 100;

function fieldHealingPort(
  port: WidgetPort,
  identity: FieldIdentity,
): { readonly port: WidgetPort; readonly target: WidgetTarget } {
  let current = identity.target;
  let reacquisitions = 0;
  const owns = (ref: string): boolean => ref === identity.target.ref || ref === current.ref;
  const run = async <T>(ref: string, operation: (liveRef: string) => Promise<T>): Promise<T> => {
    const effective = owns(ref) ? current.ref : ref;
    try {
      return await operation(effective);
    } catch (error) {
      if (!isStaleRefError(error) || !owns(ref) || reacquisitions >= MAX_REACQUISITIONS)
        throw error;
      reacquisitions += 1;
      const next = await reacquireTarget(port, identity, current);
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

/**
 * Find the target again after the page replaced its node.
 *
 * Re-acquisition is deliberately more permissive than the caller's first
 * resolution, and the difference is not a relaxation of the no-guessing rule.
 * Choosing *which field the caller meant* is a value decision — "Check-in" and
 * "Check-out" share a prefix, and picking one would silently fill the wrong
 * date — so the initial resolve still refuses anything ambiguous. Choosing
 * *which live node is the control already identified* is not: opening a picker
 * routinely mounts a second copy of its own trigger inside the popup, and the
 * copies mirror each other. Refusing there abandoned the drive every time on
 * such a site, and the fill is still verified end to end afterwards, so
 * settling it deterministically cannot report a wrong value as success.
 */
async function reacquireTarget(
  port: WidgetPort,
  identity: FieldIdentity,
  current: WidgetTarget,
): Promise<WidgetTarget | null> {
  const observation = await port.observe({ cap: 400, trackDigest: false });
  const queries = [identity.field, identity.target.name, identity.target.name.split(',')[0] ?? '']
    .map((value) => value.trim())
    .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  for (const query of queries) {
    const match = resolveField(query, observation.interactables, current);
    if (match) return toTarget(match);
  }
  return null;
}

/**
 * Resolve a field string to one interactable.
 *
 * With `preferred` supplied the caller is re-acquiring a control it already
 * identified, so same-named duplicates are ranked rather than rejected: an
 * exact name match wins over a prefix, the original role wins over a different
 * one, and document order settles the rest. Without it, an ambiguous tier is
 * still no answer at all.
 */
function resolveField(
  field: string,
  interactables: readonly AgentInteractable[],
  preferred?: WidgetTarget,
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
  if (!winner || winner.length === 0) return null;
  if (winner.length === 1) return winner[0]!;
  if (!preferred) return null;
  const sameRole = winner.filter((entry) => entry.role === preferred.role);
  const pool = sameRole.length > 0 ? sameRole : winner;
  const sameGroup = pool.filter((entry) => (entry.group ?? null) === preferred.group);
  return (sameGroup.length > 0 ? sameGroup : pool)[0]!;
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
