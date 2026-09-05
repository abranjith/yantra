import type { AgentInteractable } from '../browser/agent-controller.js';
import {
  assertReceivable,
  commitText,
  classifyFailure,
  createRunState,
  editeeProbe,
  enterText,
  escalationLedgerOf,
  isFormattingEquivalent,
  resolveInteractable,
  renderInteractionMessage,
  runEscalationPlan,
  runStatePort,
  substitutionEvidence,
  toWireLedger,
  type ChoiceSubstitution,
  type InteractionFamily,
  type MutableRunState,
  type SerializedVerdict,
  type TypingFailure,
} from '../interaction/index.js';
import {
  watchAndSelectOffered,
  type OfferedSelection,
} from '../widgets/combobox/combobox-driver.js';
import {
  isOfferedCalendarLabel,
  selectByOfferedCalendarLabel,
} from '../widgets/date/calendar-driver.js';
import { pendingRangePartner, resolveDatePair } from '../widgets/date/date-pair.js';
import { createDefaultWidgetRegistry } from '../widgets/default-registry.js';
import { probeOpen, type ProbeOutcome } from '../widgets/open-probe.js';
import { resolveContainer } from '../widgets/open-state.js';
import { nativeSelectDriver } from '../widgets/option/native-select-driver.js';
import type { DetectedWidgetDriver } from '../widgets/registry.js';
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
import { asPlanBudget, buildDriverPlan, buildTextPlan } from './plans.js';
import {
  fillFailure,
  type FieldIdentity,
  type FillBudget,
  type FillFailure,
  type FillIntent,
  type FillOutcome,
  type FillResolution,
  type CauseFor,
  type FillCause,
} from './types.js';

/**
 * Deterministically fill one named control, verify its committed value, and
 * release any floating widget it opened.
 */
export async function fillField(
  port: WidgetPort,
  identity: FieldIdentity,
  intent: FillIntent,
  requestedBudget: FillBudget = defaultWidgetBudget(port),
): Promise<FillOutcome> {
  // One run per top-level fill: created here when nothing above owns one,
  // adopted when a caller already does. Every plan, driver and nested call
  // below receives it on the budget, so the action ceiling, the deadline, the
  // re-acquisition cap and the verdict sequence are one thing for this call.
  const runState = requestedBudget.run ?? createRunState(asPlanBudget(requestedBudget), port.now());
  const budget: FillBudget = { ...requestedBudget, run: runState };
  // Wrapped before the first read, so range resolution — work this call does
  // outside any rung — is charged like everything else it spends.
  const counted = runStatePort(port, runState);
  const entry = await rangeEntryPoint(counted, identity, intent);
  const healed = runnerPortForField(counted, entry, runState);
  const target = healed.target;
  let driver: string;
  let committed: string;
  let reactionDismissed = false;
  let driven: WidgetContainer | null = null;
  /**
   * Every verdict this call has produced, in the one wire projection.
   *
   * Read from the run rather than concatenated from driver-local and typing
   * ledgers: those were four sequences pretending to be one, and merging them
   * put two records describing the same nine seconds at two nesting levels
   * next to each other as though they had happened in turn.
   */
  const attemptedSoFar = (): readonly SerializedVerdict[] =>
    toWireLedger(escalationLedgerOf(runState, { operation: 'fill-field', family: 'field' }));
  /** The option label the widget was actually made to choose, when it chose. */
  let chosen: string | null = null;
  /** What the widget was showing at that moment. */
  let offered: readonly string[] = [];
  /** True when the control rewrote the typed text rather than truncating it. */
  let reformatted = false;
  /** What the control itself held after accepting the typed text, if anything. */
  let acceptedText: string | null = null;
  /** The control the drive re-targeted to, when the page routed the edit away. */
  let editee: WidgetTarget | null = null;
  /** A choice made only because every model-visible survivor was identical. */
  let substitution: ChoiceSubstitution | null = null;

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
    const ignoredContainer =
      shape.linkedPopup || !shape.textLike
        ? null
        : await resolveContainer(healed.port, target, { allowUnlinked: true });

    const offeredCalendarLabel =
      intent.kind === 'text' ? intent.text : intent.kind === 'option' ? intent.value : null;
    const calendarLabelDrivers =
      offeredCalendarLabel !== null && isOfferedCalendarLabel(offeredCalendarLabel)
        ? await WIDGET_REGISTRY.detectDrivers(healed.port, target, 'date')
        : [];
    const receivesOfferedCalendarLabel = calendarLabelDrivers.some(
      ({ driver: candidate }) => candidate.kind === 'calendar-grid',
    );

    if (offeredCalendarLabel !== null && receivesOfferedCalendarLabel) {
      const outcome = await selectByOfferedCalendarLabel(
        healed.port,
        target,
        offeredCalendarLabel,
        budget,
      );
      if (!outcome.ok) return fromWidgetFailure(outcome, attemptedSoFar(), 'date');
      ({ driver, committed } = outcome);
      driven = outcome.container ?? null;
      chosen = outcome.chosen ?? null;
      offered = outcome.offered ?? [];
      substitution = outcome.substitution ?? null;
    } else if (intent.kind === 'secret') {
      return fillFailure(
        'FILL_VALUE_INVALID',
        'value-malformed',
        'Secret intents must be resolved at the execution boundary and passed to fillField as text with secret verification disabled.',
        { key: intent.key },
        false,
      );
    } else if (intent.kind === 'toggle') {
      const current = await readChecked(healed.port, target);
      if (current !== intent.checked) {
        await healed.port.click(target.ref);
      }
      const checked = await readChecked(healed.port, target);
      if (checked !== intent.checked) {
        return fillFailure(
          'WIDGET_NOT_COMMITTED',
          'control-refused-value',
          `The ${target.role} "${target.name}" did not commit the requested checked state.`,
          { checked, observed: checked ? 'checked' : 'unchecked' },
        );
      }
      driver = 'toggle';
      committed = checked ? 'checked' : 'unchecked';
    } else if (shape.tag === 'select') {
      const optionIntent = asOptionIntent(intent);
      if (!optionIntent) return incompatible(target, intent);
      const confidence = await nativeSelectDriver.detect(healed.port, target);
      const attempt = await driveFamilyPlan(healed.port, target, optionIntent, budget, 'option', [
        { driver: nativeSelectDriver, confidence },
      ]);
      if (!attempt.ok) return fromWidgetFailure(attempt.failure, attemptedSoFar(), 'option');
      ({ driver, committed } = attempt.outcome);
      chosen = attempt.outcome.chosen ?? null;
      offered = attempt.outcome.offered ?? [];
      substitution = attempt.outcome.substitution ?? null;
    } else if (intent.kind === 'date' || intent.kind === 'date_range') {
      // Ordered by each driver's own confidence, and tried in turn. A trigger
      // that will not accept typed text falls through to the calendar that
      // opens from it — which is the difference between reaching a month four
      // pages away and reporting the date as uncommittable.
      const attempt = await driveFamilyPlan(healed.port, target, intent, budget, 'date');
      if (!attempt.ok) return fromWidgetFailure(attempt.failure, attemptedSoFar(), 'date');
      ({ driver, committed } = attempt.outcome);
      driven = attempt.outcome.container ?? null;
      substitution = attempt.outcome.substitution ?? null;
    } else if (!shape.textLike && intent.kind === 'option') {
      const attempt = await driveFamilyPlan(healed.port, target, intent, budget, 'option');
      if (!attempt.ok) return fromWidgetFailure(attempt.failure, attemptedSoFar(), 'option');
      ({ driver, committed } = attempt.outcome);
      driven = attempt.outcome.container ?? null;
      chosen = attempt.outcome.chosen ?? null;
      offered = attempt.outcome.offered ?? [];
      substitution = attempt.outcome.substitution ?? null;
    } else if ((intent.kind === 'text' || intent.kind === 'option') && shape.textLike) {
      const text = intent.kind === 'text' ? intent.text : intent.value;
      // The combobox family first. A control that declares itself a suggestion
      // control gets the whole choreography — editee, query plan, ranking
      // against the full request — instead of the one-shot type-and-watch the
      // plain-text path performs. `asOptionIntent` is reused rather than
      // widening `WidgetIntent`; the free-text decision it erases stays here,
      // in `resolutionFor`, and never travels down to the driver.
      const optionIntent = asOptionIntent(intent);
      const combobox = optionIntent
        ? await driveFamilyPlan(healed.port, target, optionIntent, budget, 'combobox')
        : null;
      if (combobox?.tried) {
        if (!combobox.ok) return fromWidgetFailure(combobox.failure, attemptedSoFar(), 'combobox');
        ({ driver, committed } = combobox.outcome);
        driven = combobox.outcome.container ?? null;
        chosen = combobox.outcome.chosen ?? null;
        offered = combobox.outcome.offered ?? [];
        substitution = combobox.outcome.substitution ?? null;
        editee = combobox.outcome.editee ?? null;
        reformatted = combobox.outcome.reformatted ?? false;
        reactionDismissed = combobox.outcome.released ?? false;
        // With nothing chosen, the control's own value is the authority for a
        // mask that rewrote what was typed — the same rule the plain-text path
        // applies, reached through the driver's disclosure instead of its own
        // typing outcome.
        acceptedText = chosen === null ? committed : null;
      } else {
        // Confirm the characters landed before anything downstream reasons about
        // them. A control that swallows the leading keystroke used to send its
        // own truncated fragment to the site's autocomplete, and the suggestion
        // that came back was ranked and committed as though it answered the
        // request.
        //
        // And confirm they landed *here*. A trigger that opens an overlay and
        // routes keystrokes into the overlay's own input answers all three typing
        // rungs identically, so this asks where the text went before spending
        // two more mechanisms on a node that was never the editee.
        // The WHERE rung, only where it can pay for itself. A control that
        // declares no popup has nothing to delegate to, and asking anyway would
        // charge every plain text box an observation it can never use — so the
        // rung runs when the caller already handed us a before-picture, or when
        // the control says it opens something.
        const probe =
          entry.observation !== undefined
            ? editeeProbe(healed.port, entry.observation)
            : shape.linkedPopup
              ? editeeProbe(healed.port)
              : undefined;
        let live = target;
        /**
         * The verdicts the typing ladder itself produced, and only those.
         *
         * More than one entry mechanism means the control changed underneath
         * the original baseline, so its old unlinked container stops being
         * evidence that a newly observed popup should be ignored. Counting the
         * whole run here instead would make every ordinary fill look like a
         * multi-mechanism one.
         */
        let typingVerdicts: readonly SerializedVerdict[] = [];
        const textPlan = buildTextPlan<PlainTextReaction, FillFailure>({
          port: healed.port,
          budget,
          runEnter: async ({ port: planPort }) => {
            const entered = await enterText(planPort, target, text, budget, probe);
            typingVerdicts = entered.attempted;
            if (!entered.typed.ok) {
              return { ok: false, failure: fromTypingFailure(entered.typed, attemptedSoFar()) };
            }
            editee = entered.editee;
            live = entered.target;
            reformatted = entered.typed.reformatted;
            acceptedText = entered.typed.committed;
            return {
              ok: true,
              value: {
                ok: true,
                committed: entered.typed.committed,
                selected: false,
                dismissed: false,
                actions: 0,
              },
              evidence: {
                'text-entered': true,
                committed: entered.typed.committed,
                ...(entered.editee ? { editee: entered.editee.name } : {}),
              },
            };
          },
          runSelection: async ({ port: planPort }) => {
            const selection = await watchAndSelectOffered(planPort, live, text, budget, {
              // A multi-mechanism entry means the control changed underneath
              // the original baseline. Its old unlinked container is no
              // longer reliable evidence that a newly observed popup should
              // be ignored.
              ignoredContainer: performed(typingVerdicts) > 1 ? null : ignoredContainer,
            });
            const reacted = resolveOfferedSelection(live, text, selection, 'text');
            return reacted.ok
              ? {
                  ok: true,
                  value: reacted,
                  evidence: {
                    committed: reacted.committed,
                    offered: reacted.offered ?? [],
                    ...(reacted.chosen === undefined ? {} : { chosen: reacted.chosen }),
                    // A choice made only because every survivor looked
                    // identical is disclosed as counts and rung names.
                    ...(reacted.substitution ? substitutionEvidence(reacted.substitution) : {}),
                  },
                }
              : { ok: false, failure: reacted };
          },
          classify: (failure) => classifyFailure(failure.errorCode, failure.details),
        });
        const textRun = await runEscalationPlan(textPlan);
        if (textRun.outcome === null) {
          return fillFailure(
            'WIDGET_TARGET_UNREACHABLE',
            'budget',
            'The fill action budget was exhausted before the text plan could run.',
            { reason: 'budget' },
          );
        }
        if (!textRun.outcome.ok) return textRun.outcome.failure;
        const reacted = textRun.outcome.value;
        committed = reacted.committed;
        reactionDismissed = reacted.dismissed;
        driver = reacted.selected ? 'typeahead' : 'plain-text';
        chosen = reacted.chosen ?? null;
        offered = reacted.offered ?? [];
        substitution = reacted.substitution ?? null;
      }
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
      const requestedText =
        intent.kind === 'text' ? intent.text : intent.kind === 'option' ? intent.value : null;
      return (
        acceptedText !== null &&
        requestedText !== null &&
        isFormattingEquivalent(acceptedText, requestedText) &&
        matchesCommitment(value, acceptedText)
      );
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
      editee,
    );
    if (settled === null) {
      return (
        rangeIncomplete(target, intent, pendingPartner) ??
        fillFailure(
          'WIDGET_NOT_COMMITTED',
          'value-rejected-on-release',
          `The "${target.name}" control does not reflect the requested value.`,
          {
            committed: dismissed.committed,
            observed: dismissed.committed,
            ...(offered.length > 0 ? { offered } : {}),
            ...(chosen === null ? {} : { chosen }),
            ...(performed(attemptedSoFar()) > 0 ? { attempted: attemptedSoFar() } : {}),
          },
        )
      );
    }
    const requested = describeIntent(intent);
    const allAttempts = attemptedSoFar();
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
      actions: healed.actions(),
      dismissed: reactionDismissed || dismissed.dismissed,
      requested,
      resolution,
      ...(editee === null
        ? {}
        : { editee: { ref: editee.ref, name: editee.name, role: editee.role } }),
      ...(offered.length > 0 ? { offered } : {}),
      ...(substitution === null ? {} : { substitution }),
      ...(noteFor(target.name, requested, settled, resolution, offered, substitution) ?? {}),
      // Only when it says something. One driver, one successful attempt is the
      // ordinary case and reporting it as recovery is noise. Skipped rungs are
      // carried once there is something to report, never on their own.
      ...(performed(allAttempts) > 1 || substitution !== null ? { attempted: allAttempts } : {}),
    };
  } catch (error) {
    if (isStaleRefError(error)) {
      return fillFailure(
        'WIDGET_ELEMENT_REPLACED',
        'element-replaced',
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
  requestedBudget: FillBudget = defaultWidgetBudget(port),
): Promise<FillOutcome> {
  if (port.now() > requestedBudget.deadlineMs || requestedBudget.maxActions < 1) {
    return fillFailure(
      'WIDGET_TARGET_UNREACHABLE',
      'budget',
      'The fill action budget was exhausted before the secret could be committed.',
      { reason: 'budget' },
    );
  }
  const runState = requestedBudget.run ?? createRunState(asPlanBudget(requestedBudget), port.now());
  const budget: FillBudget = { ...requestedBudget, run: runState };
  const healed = runnerPortForField(port, identity, runState);
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
      attempted: typed.attempted,
    };
  } catch (error) {
    if (isStaleRefError(error)) {
      return fillFailure(
        'WIDGET_ELEMENT_REPLACED',
        'element-replaced',
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
  editee: WidgetTarget | null = null,
): Promise<string | null> {
  if (satisfied(committed)) return committed;
  // A page that routed the edit into an overlay's own input sometimes leaves
  // the value there rather than writing it back to the control the caller
  // named. Reading the node that was actually edited is not a relaxation of
  // verification — it is verification against the right node.
  if (editee) {
    const fromEditee = await readCommitted(port, editee);
    if (satisfied(fromEditee)) return fromEditee;
  }
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
    'range-half-discarded',
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
  | {
      readonly ok: true;
      readonly outcome: WidgetSuccess;
      readonly tried: true;
    }
  | {
      readonly ok: false;
      readonly failure: WidgetFailure;
      /**
       * Whether any driver in the family was confident enough to act.
       *
       * A family that recognised nothing is not a failure to report — it is a
       * routing answer, and the caller falls through to whatever path owns the
       * control instead. Only a driver that ran and said no is a real failure.
       */
      readonly tried: boolean;
    };

/** Execute one declared family plan through the shared escalation runner. */
async function driveFamilyPlan(
  port: WidgetPort,
  target: WidgetTarget,
  intent: WidgetIntent,
  budget: FillBudget,
  family: WidgetFamily,
  declaredCandidates?: readonly DetectedWidgetDriver[],
): Promise<DriverAttempt> {
  const candidates =
    declaredCandidates ?? (await WIDGET_REGISTRY.detectDrivers(port, target, family));
  const probeEligible = candidates.length === 0 && family !== 'combobox';
  const probeState: { value: ProbeOutcome | null } = { value: null };
  const plan = buildDriverPlan({
    family,
    port,
    target,
    intent,
    budget,
    candidates,
    isWrongDriver,
    probeEligible,
    ...(family === 'combobox'
      ? {}
      : {
          runProbe: async ({ port: livePort }) => {
            const probed = await probeOpen(livePort, target, family, budget, {
              intent,
              detect: (probePort, probeTarget, probeFamily) =>
                WIDGET_REGISTRY.detectDrivers(probePort, probeTarget, probeFamily),
              detectOpen: (probePort, probeTarget, container, probeFamily) =>
                WIDGET_REGISTRY.detectOpenDrivers(probePort, probeTarget, container, probeFamily),
              // The revealed candidates run as an ordinary family sub-plan on
              // the shared run, so their `driver:<kind>` verdicts arrive in the
              // one sequence — no map of driver-local ledgers to splice back in.
              drive: async (revealed, probePort) => {
                const nested = await driveFamilyPlan(
                  probePort,
                  target,
                  intent,
                  budget,
                  family,
                  revealed,
                );
                return nested.ok ? nested.outcome : nested.failure;
              },
            });
            probeState.value = probed;
            if (probed.kind === 'driven') {
              // The registry kind, never page text: what opening turned out to
              // reveal is the whole answer to "why did this fill click first".
              const evidence = { revealed_driver: probed.revealedDriver };
              return probed.outcome.ok
                ? { ok: true as const, value: probed.outcome, evidence }
                : { ok: false as const, failure: probed.outcome, evidence };
            }
            if (probed.kind === 'unrecognized') {
              return { ok: false as const, failure: probed.failure };
            }
            return {
              ok: false as const,
              failure: widgetFailure(
                'WIDGET_NOT_RECOGNIZED',
                'driver-not-recognized',
                `No ${family} widget driver recognized "${target.name}" with sufficient confidence.`,
                { family },
              ),
            };
          },
        }),
  });
  // Ordering is the runner's single sequence. A nested rung's verdict precedes
  // its enclosing rung's because ordinals are assigned on completion, so there
  // is nothing left to merge and nothing left to renumber.
  const run = await runEscalationPlan(plan);
  const probed = probeState.value;
  if (run.outcome === null) {
    return {
      ok: false,
      failure: widgetFailure(
        'WIDGET_NOT_RECOGNIZED',
        'driver-not-recognized',
        `No ${family} widget driver recognized "${target.name}" with sufficient confidence.`,
        { family },
      ),
      tried: false,
    };
  }
  if (run.outcome.ok) {
    return { ok: true, outcome: run.outcome.value, tried: true };
  }
  // Wave 1's deliberate exception to "report the ledger only when it says
  // something": that the control opened and nothing recognised what it revealed
  // is the whole answer, even on its own.
  const failure =
    probed?.kind === 'unrecognized'
      ? {
          ...run.outcome.failure,
          details: { ...run.outcome.failure.details, attempted: toWireLedger(run.ledger) },
        }
      : run.outcome.failure;
  return { ok: false, failure, tried: candidates.length > 0 || probed !== null };
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
  if (state.reformatted) return 'reformatted';
  if (normalize(state.committed) === normalize(state.requested)) return 'exact';
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
  substitution: ChoiceSubstitution | null,
): { readonly note: string } | null {
  if (substitution !== null) {
    return {
      note: renderInteractionMessage('success-note', 'FILL_SUCCESS_NOTE', 'structural_tie_break', {
        field,
        count: substitution.indistinguishable,
        label: substitution.label,
      }).message,
    };
  }
  if (resolution === 'exact') return null;
  if (resolution === 'single_offered_match') {
    return {
      note: renderInteractionMessage('success-note', 'FILL_SUCCESS_NOTE', resolution, {
        field,
        requested,
        committed,
      }).message,
    };
  }
  if (resolution === 'selected_from_offered') {
    return {
      note: renderInteractionMessage('success-note', 'FILL_SUCCESS_NOTE', resolution, {
        field,
        requested,
        committed,
        offeredCount: offered.length,
      }).message,
    };
  }
  if (resolution === 'reformatted') {
    return {
      note: renderInteractionMessage('success-note', 'FILL_SUCCESS_NOTE', resolution, {
        field,
        requested,
        committed,
      }).message,
    };
  }
  return {
    note: renderInteractionMessage('success-note', 'FILL_SUCCESS_NOTE', resolution, {
      field,
      committed,
    }).message,
  };
}

/** Successful resolution of the post-type offered-selection stage. */
interface PlainTextReaction {
  readonly ok: true;
  readonly committed: string;
  readonly selected: boolean;
  readonly dismissed: boolean;
  readonly actions: number;
  readonly chosen?: string;
  readonly offered?: readonly string[];
  readonly substitution?: ChoiceSubstitution;
}

/** Map selection facts into the fill vocabulary at the engine decision point. */
function resolveOfferedSelection(
  target: WidgetTarget,
  requested: string,
  selection: OfferedSelection,
  emitter: InteractionFamily,
): PlainTextReaction | FillFailure {
  switch (selection.kind) {
    case 'selected':
      return {
        ok: true,
        committed: selection.committed,
        selected: true,
        dismissed: !selection.stillOpen,
        actions: selection.actions,
        chosen: selection.chosen,
        offered: selection.offered,
        ...(selection.substitution ? { substitution: selection.substitution } : {}),
      };
    case 'no-suggestions':
      return {
        ok: true,
        committed: selection.committed,
        selected: false,
        dismissed: selection.dismissed,
        actions: selection.actions,
      };
    case 'unmatched-text-stands':
      return {
        ok: true,
        committed: selection.committed,
        selected: false,
        dismissed: true,
        actions: selection.actions,
        ...(selection.offered.length > 0 ? { offered: selection.offered } : {}),
      };
    case 'ambiguous':
      assertReceivable('fill', 'WIDGET_AMBIGUOUS_CHOICE', 'several-matched-equally', emitter);
      return fillFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        'several-matched-equally',
        `"${target.name}" offers ${selection.offered.length} suggestions matching "${requested}" equally well, so none was chosen.`,
        { offered: selection.offered, observed: selection.observed },
      );
    case 'text-discarded':
      assertReceivable(
        'fill',
        'WIDGET_TARGET_UNREACHABLE',
        selection.semantics === 'declared' ? 'no-suggestion-matched' : 'no-options-offered',
        emitter,
      );
      return fillFailure(
        'WIDGET_TARGET_UNREACHABLE',
        selection.semantics === 'declared' ? 'no-suggestion-matched' : 'no-options-offered',
        `"${target.name}" offers no suggestion matching "${requested}" and discarded the typed text on release, so it will not accept a free-text value.`,
        {
          ...(selection.semantics === 'declared' ? { offered: selection.offered } : {}),
          observed: selection.observed,
        },
      );
    case 'not-committed':
      return fillFailure(
        'WIDGET_NOT_COMMITTED',
        'control-refused-value',
        `The suggestion "${selection.chosen}" was clicked, but "${target.name}" has no committed value.`,
        {
          committed: selection.committed,
          observed: selection.committed,
          offered: selection.offered,
          chosen: selection.chosen,
        },
      );
    case 'budget':
      return fillFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        'The fill action budget was exhausted before the suggestion could be selected.',
        { reason: 'budget', offered: selection.offered },
      );
  }
}

/**
 * Translate the interaction layer's typing outcome into the fill vocabulary.
 *
 * The ledger travels with it: a control that refused three different entry
 * mechanisms must not read like one nobody tried, or the caller repeats work
 * the tool already exhausted.
 */
function fromTypingFailure(
  failure: TypingFailure,
  attempted: readonly SerializedVerdict[] = failure.attempted,
): FillFailure {
  const details = {
    observed: failure.observed,
    attempted,
    ...(failure.editee === undefined ? {} : { editee: failure.editee.name }),
    ...(failure.reason === undefined ? {} : { reason: failure.reason }),
  };
  // The two arms are the whole point of the cause discriminator: both carry
  // WIDGET_NOT_COMMITTED, and before this they read identically.
  if (failure.errorCode === 'WIDGET_NOT_COMMITTED') {
    const cause =
      failure.editee !== undefined
        ? 'keystrokes-landed-elsewhere'
        : failure.reason === 'budget'
          ? 'budget'
          : 'typing-exhausted';
    assertReceivable('fill', 'WIDGET_NOT_COMMITTED', cause, 'text');
    return fillFailure('WIDGET_NOT_COMMITTED', cause, failure.message, details);
  }
  return fillFailure('WIDGET_TARGET_UNREACHABLE', 'budget', failure.message, details);
}

function asOptionIntent(intent: FillIntent): WidgetIntent | null {
  if (intent.kind === 'option') return intent;
  if (intent.kind === 'text') return { kind: 'option', value: intent.text };
  return null;
}

function incompatible(target: WidgetTarget, intent: FillIntent): FillFailure {
  return fillFailure(
    'WIDGET_TARGET_UNREACHABLE',
    'intent-incompatible',
    `The ${target.role} "${target.name}" cannot accept a ${intent.kind} fill intent.`,
    { role: target.role, intent: intent.kind },
  );
}

/**
 * Translate a driver's failure into the fill vocabulary, cause and all.
 *
 * An exhaustive switch rather than a lookup, because the remap from widget code
 * to fill code has to leave a `(code, cause)` pair the table actually declares —
 * and the compiler is a better guarantee of that than a comment. The narrowing
 * helpers below map any incoming cause into the set its destination code can
 * carry; they are total functions into a legal set, never a generic sentence.
 */
function fromWidgetFailure(
  failure: WidgetFailure,
  attempted: readonly SerializedVerdict[],
  emitter: WidgetFamily,
): FillFailure {
  const details = performed(attempted) > 1 ? { ...failure.details, attempted } : failure.details;
  switch (failure.errorCode) {
    case 'WIDGET_NOT_RECOGNIZED':
    case 'WIDGET_TARGET_UNREACHABLE': {
      const cause = unreachableCause(failure.cause, details);
      assertReceivable('fill', 'WIDGET_TARGET_UNREACHABLE', cause, emitter);
      return fillFailure(
        'WIDGET_TARGET_UNREACHABLE',
        cause,
        failure.message,
        details,
        failure.retryable,
      );
    }
    case 'WIDGET_NOT_COMMITTED': {
      const cause = notCommittedCause(failure.cause);
      assertReceivable('fill', 'WIDGET_NOT_COMMITTED', cause, emitter);
      return fillFailure(
        'WIDGET_NOT_COMMITTED',
        cause,
        failure.message,
        details,
        failure.retryable,
      );
    }
    case 'WIDGET_DID_NOT_OPEN':
      return fillFailure(
        'WIDGET_DID_NOT_OPEN',
        'picker-did-not-open',
        failure.message,
        details,
        failure.retryable,
      );
    case 'WIDGET_AMBIGUOUS_CHOICE':
      assertReceivable('fill', 'WIDGET_AMBIGUOUS_CHOICE', 'several-matched-equally', emitter);
      return fillFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        'several-matched-equally',
        failure.message,
        details,
        failure.retryable,
      );
    case 'WIDGET_MAPPING_UNSAFE':
      return fillFailure(
        'WIDGET_MAPPING_UNSAFE',
        'mapping-unsafe',
        failure.message,
        details,
        failure.retryable,
      );
    case 'WIDGET_ELEMENT_REPLACED':
      return fillFailure(
        'WIDGET_ELEMENT_REPLACED',
        'element-replaced',
        failure.message,
        details,
        failure.retryable,
      );
  }
}

/** Any cause, narrowed to one WIDGET_TARGET_UNREACHABLE can carry. */
function unreachableCause(
  cause: FillCause,
  details: Readonly<Record<string, unknown>>,
): CauseFor<'WIDGET_TARGET_UNREACHABLE'> {
  switch (cause) {
    case 'value-not-offered':
    case 'date-not-reachable':
    case 'no-suggestion-matched':
    case 'no-options-offered':
    case 'picker-did-not-open':
    case 'intent-incompatible':
    case 'budget':
      return cause;
    case 'driver-not-recognized':
      // The probe distinguishes these two by what it actually saw, and they
      // read differently: nothing opened at all is a different next step from
      // something opened that no driver understood.
      return details.containerResolved === false ? 'picker-did-not-open' : 'driver-not-recognized';
    default:
      return 'driver-not-recognized';
  }
}

/** Any cause, narrowed to one WIDGET_NOT_COMMITTED can carry. */
function notCommittedCause(cause: FillCause): CauseFor<'WIDGET_NOT_COMMITTED'> {
  switch (cause) {
    case 'keystrokes-landed-elsewhere':
    case 'typing-exhausted':
    case 'value-rejected-on-release':
    case 'budget':
      return cause;
    default:
      return 'control-refused-value';
  }
}

async function readChecked(port: WidgetPort, target: WidgetTarget): Promise<boolean> {
  return port.evaluateOn(target.ref, (element) => {
    if (element instanceof HTMLInputElement) return element.checked;
    return element.getAttribute('aria-checked') === 'true';
  });
}

/**
 * How many of these verdicts describe work that was actually performed.
 *
 * A skipped rung was not run, so it never makes a ledger worth reporting on its
 * own — but it is carried once something else does.
 */
function performed(attempted: readonly SerializedVerdict[]): number {
  return attempted.filter((record) => record.verdict !== 'skipped').length;
}

/** How long a released widget is given to finish writing a paired range. */
const COMMIT_SETTLE_MS = 1_000;
/** Polling cadence while waiting for that write. */
const COMMIT_SETTLE_POLL_MS = 100;

/**
 * The one port every rung of one fill charges through.
 *
 * Built from the shared run-charging wrapper rather than a second
 * implementation with its own private counter and its own private
 * re-acquisition cap: a fill that spends actions inside a driver, inside the
 * typing ladder and outside any rung at all must answer "how much did this
 * call spend" once, not four times.
 */
function runnerPortForField(
  port: WidgetPort,
  identity: FieldIdentity,
  state: MutableRunState,
): { readonly port: WidgetPort; readonly target: WidgetTarget; readonly actions: () => number } {
  // Ownership, expressed by declining rather than by a second ref map: an
  // unrelated candidate ref inside a popup is not this field, and healing it to
  // the field would drive the wrong node.
  let owned = identity.target.ref;
  state.reacquire = async (currentRef) => {
    if (currentRef !== owned && currentRef !== identity.target.ref) return null;
    const next = await reacquireTarget(port, identity, { ...identity.target, ref: currentRef });
    if (!next) return null;
    owned = next.ref;
    return next.ref;
  };
  const adapted = runStatePort(port, state);
  // Drivers keep the original target object. The adapted port maps that ref to
  // the current one after the single stronger field-string re-acquisition.
  return { port: adapted, target: identity.target, actions: () => state.chargedActions };
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
  const resolved = resolveInteractable(
    field,
    interactables,
    preferred ? { preferred, allowEquivalentCopies: true } : {},
  );
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
