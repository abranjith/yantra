import type { AgentInteractable } from '../browser/agent-controller.js';
import {
  commitText,
  EMPTY_LEDGER,
  ledgerOf,
  resolveInteractable,
  type AttemptLedger,
  type AttemptRecord,
  type TypingFailure,
} from '../interaction/index.js';
import { pendingRangePartner, resolveDatePair } from '../widgets/date/date-pair.js';
import { createDefaultWidgetRegistry } from '../widgets/default-registry.js';
import { resolveContainer } from '../widgets/open-state.js';
import { nativeSelectDriver } from '../widgets/option/native-select-driver.js';
import {
  defaultWidgetBudget,
  widgetFailure,
  type WidgetContainer,
  type WidgetFailure,
  type WidgetFamily,
  type WidgetIntent,
  type WidgetPort,
  type WidgetSuccess,
  type WidgetTarget,
} from '../widgets/types.js';
import { matchesCommitment, matchesIntent, readCommitted } from '../widgets/verify.js';

import { dismissWidget } from './dismiss.js';
import { watchAndSelect } from './react.js';
import {
  fillFailure,
  type FieldIdentity,
  type FillBudget,
  type FillFailure,
  type FillIntent,
  type FillOutcome,
  type FillResolution,
} from './types.js';

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
  let typingLedger: AttemptLedger = EMPTY_LEDGER;
  /** The option label the widget was actually made to choose, when it chose. */
  let chosen: string | null = null;
  /** What the widget was showing at that moment. */
  let offered: readonly string[] = [];
  /** True when the control rewrote the typed text rather than truncating it. */
  let reformatted = false;
  /** What the control itself held after accepting the typed text, if anything. */
  let acceptedText: string | null = null;
  /** Which widget drivers were tried, when more than one was. */
  let driverLedger: AttemptLedger = EMPTY_LEDGER;

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
      chosen = outcome.chosen ?? null;
      offered = outcome.offered ?? [];
    } else if (intent.kind === 'date' || intent.kind === 'date_range') {
      // Ordered by each driver's own confidence, and tried in turn. A trigger
      // that will not accept typed text falls through to the calendar that
      // opens from it — which is the difference between reaching a month four
      // pages away and reporting the date as uncommittable.
      const attempt = await driveWithFallback(healed.port, target, intent, budget, 'date');
      if (!attempt.ok) return fromWidgetFailure(attempt.failure, attempt.ledger);
      ({ driver, committed, actions } = attempt.outcome);
      driven = attempt.outcome.container ?? null;
      driverLedger = attempt.ledger;
    } else if (!shape.textLike && intent.kind === 'option') {
      const attempt = await driveWithFallback(healed.port, target, intent, budget, 'option');
      if (!attempt.ok) return fromWidgetFailure(attempt.failure, attempt.ledger);
      ({ driver, committed, actions } = attempt.outcome);
      driven = attempt.outcome.container ?? null;
      chosen = attempt.outcome.chosen ?? null;
      offered = attempt.outcome.offered ?? [];
      driverLedger = attempt.ledger;
    } else if ((intent.kind === 'text' || intent.kind === 'option') && shape.textLike) {
      const text = intent.kind === 'text' ? intent.text : intent.value;
      // Confirm the characters landed before anything downstream reasons about
      // them. A control that swallows the leading keystroke used to send its
      // own truncated fragment to the site's autocomplete, and the suggestion
      // that came back was ranked and committed as though it answered the
      // request.
      const typed = await commitText(healed.port, target, text, budget);
      if (!typed.ok) return fromTypingFailure(typed);
      actions += typed.ledger.records.length;
      typingLedger = typed.ledger;
      reformatted = typed.reformatted;
      acceptedText = typed.committed;
      const reacted = await watchAndSelect(healed.port, target, text, budget, ignoredContainer);
      if (!reacted.ok) return reacted;
      actions += reacted.actions;
      committed = reacted.committed;
      reactionDismissed = reacted.dismissed;
      driver = reacted.selected ? 'typeahead' : 'plain-text';
      chosen = reacted.chosen ?? null;
      offered = reacted.offered ?? [];
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

    // What the committed value is checked against. When the widget was made to
    // choose from its own offered list, that choice is the authority: a field
    // asked for "DFW" that offers and commits "Dallas" has answered the request,
    // and checking it against the typed text instead is what reported a landed
    // fill as WIDGET_NOT_COMMITTED and cost the run everything downstream of it.
    //
    // With nothing chosen, the typed text is the authority — except that a
    // control which rewrote the value as it was typed has already told us what
    // it accepts. An input mask turning "5551234567" into "(555) 123-4567" was
    // otherwise failed here as uncommitted, condemning a fill the page had
    // plainly taken.
    const satisfied = (value: string): boolean => {
      if (chosen !== null) return matchesCommitment(value, chosen);
      if (matchesFillIntent(value, intent)) return true;
      return acceptedText !== null && matchesCommitment(value, acceptedText);
    };

    // Release before the authoritative verification, not after. A picker that
    // commits on release reports its old value until it closes, and a range
    // spread over a check-in/check-out pair cannot be read while the popup's
    // duplicate copy of that pair is still on the page.
    const dismissed = await dismissWidget(healed.port, target, committed, satisfied, {
      ignoredContainer,
      driven,
    });
    if (!dismissed.ok) return rangeIncomplete(target, intent, pendingPartner) ?? dismissed;
    const settled = await settledCommit(
      healed.port,
      target,
      intent,
      dismissed.committed,
      satisfied,
    );
    if (settled === null) {
      return (
        rangeIncomplete(target, intent, pendingPartner) ??
        fillFailure(
          'WIDGET_NOT_COMMITTED',
          `The "${target.name}" control does not reflect the requested value.`,
          {
            committed: dismissed.committed,
            observed: dismissed.committed,
            ...(offered.length > 0 ? { offered } : {}),
            ...(chosen === null ? {} : { chosen }),
            ...(typingLedger.records.length > 0 || driverLedger.records.length > 0
              ? { attempted: [...driverLedger.records, ...typingLedger.records] }
              : {}),
          },
        )
      );
    }
    const requested = describeIntent(intent);
    const allAttempts = [...driverLedger.records, ...typingLedger.records];
    const resolution = resolutionFor({
      requested,
      committed: settled,
      chosen,
      offered,
      reformatted,
    });
    return {
      ok: true,
      driver,
      committed: settled,
      actions: actions + dismissed.actions,
      dismissed: reactionDismissed || dismissed.dismissed,
      requested,
      resolution,
      ...(offered.length > 0 ? { offered } : {}),
      ...(noteFor(target.name, requested, settled, resolution, offered) ?? {}),
      // Only when it says something. One driver, one successful attempt is the
      // ordinary case and reporting it as recovery is noise.
      ...(allAttempts.length > 1 ? { attempted: allAttempts } : {}),
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
    // `allowEscalation: false` is load-bearing, not defensive: it keeps the
    // single-rung path AND suppresses the readback, so a resolved credential is
    // never pulled back out of the page into a ledger or a failure detail.
    const typed = await commitText(healed.port, healed.target, secretValue, budget, {
      allowEscalation: false,
    });
    if (!typed.ok) return fromTypingFailure(typed);
    return {
      ok: true,
      driver: 'plain-text',
      committed: '',
      actions: 1,
      dismissed: false,
      attempted: typed.ledger.records,
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
  satisfied: (value: string) => boolean,
): Promise<string | null> {
  if (satisfied(committed)) return committed;
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

/** The shared driver set; built once because registration is fixed. */
const WIDGET_REGISTRY = createDefaultWidgetRegistry();

/**
 * Failures that mean "this driver was the wrong choice", not "the page said no".
 *
 * Only these fall through to the next candidate. A disabled date and a calendar
 * that disagrees with its own weekday headers are definite answers, and trying
 * a second driver against them spends the budget to hear the same thing twice.
 */
function isWrongDriver(failure: WidgetFailure): boolean {
  if (failure.details.reason === 'disabled' || failure.details.reason === 'budget') return false;
  if (failure.errorCode === 'WIDGET_TARGET_UNREACHABLE') {
    return failure.details.reason === 'paired_inputs_not_found';
  }
  return ['WIDGET_NOT_RECOGNIZED', 'WIDGET_NOT_COMMITTED', 'WIDGET_DID_NOT_OPEN'].includes(
    failure.errorCode,
  );
}

/** One family's drive attempt, and the record of which drivers were tried. */
type DriverAttempt =
  | { readonly ok: true; readonly outcome: WidgetSuccess; readonly ledger: AttemptLedger }
  | { readonly ok: false; readonly failure: WidgetFailure; readonly ledger: AttemptLedger };

/**
 * Drive a control through its candidate drivers, strongest confidence first.
 *
 * The last failure is returned verbatim so the caller sees what the page
 * actually said, with the ledger naming every driver tried and why each was
 * abandoned.
 */
async function driveWithFallback(
  port: WidgetPort,
  target: WidgetTarget,
  intent: WidgetIntent,
  budget: FillBudget,
  family: WidgetFamily,
): Promise<DriverAttempt> {
  const candidates = await WIDGET_REGISTRY.detectDrivers(port, target, family);
  const records: AttemptRecord[] = [];
  let last: WidgetFailure | null = null;

  for (const [index, candidate] of candidates.entries()) {
    const startedAt = port.now();
    const outcome = await candidate.driver.drive(port, target, intent, budget);
    if (outcome.ok) {
      records.push({
        attempt: index + 1,
        strategy: `driver:${candidate.driver.kind}`,
        errorCode: null,
        elapsedMs: port.now() - startedAt,
      });
      return { ok: true, outcome, ledger: ledgerOf(records) };
    }
    records.push({
      attempt: index + 1,
      strategy: `driver:${candidate.driver.kind}`,
      errorCode: outcome.errorCode,
      elapsedMs: port.now() - startedAt,
      detail: outcome.message,
    });
    last = outcome;
    if (!isWrongDriver(outcome)) break;
    if (port.now() > budget.deadlineMs) break;
  }

  return {
    ok: false,
    failure:
      last ??
      widgetFailure(
        'WIDGET_NOT_RECOGNIZED',
        `No ${family} widget driver recognized "${target.name}" with sufficient confidence.`,
        { family },
      ),
    ledger: ledgerOf(records),
  };
}

/** Render a semantic intent as the caller expressed it, for `requested`. */
function describeIntent(intent: FillIntent): string {
  switch (intent.kind) {
    case 'text':
      return intent.text;
    case 'option':
      return intent.value;
    case 'date':
      return intent.date;
    case 'date_range':
      return `${intent.from}..${intent.to}`;
    case 'toggle':
      return intent.checked ? 'checked' : 'unchecked';
    case 'secret':
      return '';
  }
}

/**
 * Name the relationship between what was asked for and what landed.
 *
 * The distinction that matters to a caller is whether a differing value came
 * from the widget's own list — in which case the widget answered the request
 * and there is nothing to fix — or from the caller's text simply standing as
 * typed.
 */
function resolutionFor(state: {
  readonly requested: string;
  readonly committed: string;
  readonly chosen: string | null;
  readonly offered: readonly string[];
  readonly reformatted: boolean;
}): FillResolution {
  if (state.chosen !== null) {
    return state.offered.length <= 1 ? 'single_offered_match' : 'selected_from_offered';
  }
  if (normalize(state.committed) === normalize(state.requested)) return 'exact';
  if (state.reformatted) return 'reformatted';
  // No list was offered and the text is not literally what was sent — a date
  // rendered as "Wed, Dec 2" for "2026-12-02" is the everyday case, and it got
  // here only because the semantic matcher already confirmed it means the same
  // thing.
  return state.offered.length > 0 ? 'typed_literal' : 'exact';
}

/**
 * One sentence, and only when the committed value is not what was sent.
 *
 * A caller reading `committed: "Dallas"` after asking for `"DFW"` has to decide
 * whether its fill worked. Saying so outright is the difference between
 * accepting the result and spending a turn — in the motivating run, a whole run
 * — trying to force the original text back into the field.
 */
function noteFor(
  field: string,
  requested: string,
  committed: string,
  resolution: FillResolution,
  offered: readonly string[],
): { readonly note: string } | null {
  if (resolution === 'exact') return null;
  if (resolution === 'single_offered_match') {
    return {
      note: `"${field}" offered one match for "${requested}" and committed "${committed}"; that is the widget resolving your value, not a failure.`,
    };
  }
  if (resolution === 'selected_from_offered') {
    return {
      note: `"${field}" offered ${offered.length} matches for "${requested}" and committed "${committed}"; that is the widget resolving your value, not a failure.`,
    };
  }
  if (resolution === 'reformatted') {
    return { note: `"${field}" reformatted "${requested}" to "${committed}" and accepted it.` };
  }
  return {
    note: `"${field}" offered no matching suggestion, so the typed text "${committed}" stands as the value.`,
  };
}

/**
 * Translate the interaction layer's typing outcome into the fill vocabulary.
 *
 * The ledger travels with it: a control that refused three different entry
 * mechanisms must not read like one nobody tried, or the caller repeats work
 * the tool already exhausted.
 */
function fromTypingFailure(failure: TypingFailure): FillFailure {
  return fillFailure(failure.errorCode, failure.message, {
    observed: failure.observed,
    attempted: failure.ledger.records,
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
  });
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

function fromWidgetFailure(failure: WidgetFailure, ledger?: AttemptLedger): FillFailure {
  const details =
    ledger && ledger.records.length > 1
      ? { ...failure.details, attempted: ledger.records }
      : failure.details;
  if (failure.errorCode === 'WIDGET_NOT_RECOGNIZED') {
    return fillFailure('WIDGET_TARGET_UNREACHABLE', failure.message, details);
  }
  return fillFailure(failure.errorCode, failure.message, details, failure.retryable);
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
    clear: (ref) => run(ref, (liveRef) => port.clear(liveRef)),
    type: (ref, text, options) => run(ref, (liveRef) => port.type(liveRef, text, options)),
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
 * Resolve a field string to one interactable through the shared resolver.
 *
 * `preferred` is what makes same-named duplicates rankable rather than
 * refusable: the caller is re-acquiring a control it already identified, so the
 * value decision is behind it and only the "which live node" question remains.
 */
function resolveField(
  field: string,
  interactables: readonly AgentInteractable[],
  preferred?: WidgetTarget,
): AgentInteractable | null {
  const resolved = resolveInteractable(field, interactables, preferred ? { preferred } : {});
  return resolved.kind === 'match' ? resolved.entry : null;
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
