/**
 * The combobox family: one path for every control that answers typing with a
 * list of its own suggestions.
 *
 * Before this driver existed the engine had a bespoke typeahead path bolted to
 * the side of its plain-text branch, and it varied exactly one thing — how the
 * text was typed. It could not ask *where* the keystrokes were going, and it
 * could not ask a widget a different *question* when the first one produced no
 * suggestions. Both are what a real location autocomplete needs: the run that
 * motivated this feature lost three calls to a trigger that routes keystrokes
 * into an overlay, and a fourth to a hint that told it to retype a full offered
 * label into a prefix matcher.
 *
 * A driver in the registry gets the same `detect()` confidence ordering and
 * fallback chain the date and option families already have, and — more
 * importantly — it makes the choreography a single named thing that can be
 * tested, rather than a sequence spread across two modules.
 */

import { buildComboboxPlan } from '../../fill/plans.js';
import { runEscalationPlan } from '../../interaction/escalation.js';
import {
  distinguishingPrefix,
  editeeProbe,
  enterText,
  rankAgainstRequested,
  readWhenStable,
  shapeQuery,
  type AttemptLedger,
  type ChoiceSubstitution,
  type InteractionFailureCause,
  type TypingFailure,
} from '../../interaction/index.js';
import { isOpen, resolveContainer, type WidgetContainer } from '../open-state.js';
import {
  clickCandidate,
  collectChoices,
  type WidgetCandidate,
  type WidgetChoiceSet,
} from '../option/candidates.js';
import {
  widgetFailure,
  type WidgetDriver,
  type WidgetOutcome,
  type WidgetPort,
  type WidgetTarget,
} from '../types.js';
import { readCommitted } from '../verify.js';

/**
 * Longest a typed control is given to produce and settle its suggestions.
 *
 * Four seconds, not the 1.5 it once was. A remote location autocomplete on a
 * cold page routinely answers later than that, and the old cap did not merely
 * wait too little — it returned whatever happened to be on screen at the
 * buzzer, which on a slow list is the results of the *previous* keystrokes.
 * Waiting for the list to stop changing is what makes the extra window safe as
 * well as useful; a fast page still settles in two polls.
 */
export const REACTION_WAIT_MS = 4_000;
/** Polling cadence for post-type popup discovery. */
export const REACTION_POLL_MS = 150;
/** Consecutive identical reads before the suggestion list is called settled. */
export const REACTION_QUIET_POLLS = 2;
/** How many offered labels are reported back; page text, so it is capped. */
export const MAX_OFFERED = 10;

/**
 * Confidence that this control is a combobox, read from **closed state only**.
 *
 * Exported as a named function separate from `detect()` so the shape test can
 * run without driving anything. Detection errors and driving errors have
 * entirely different fixes and were previously distinguishable only by reading
 * an attempt ledger after the fact.
 *
 * Graded rather than boolean: an explicit `role="combobox"` carrying
 * `aria-autocomplete` is a page telling us exactly what it is, while an
 * editable pointing `aria-controls` at a list-shaped box is an inference — good
 * enough to act on, weak enough that a stronger driver outranks it.
 *
 * A plain `<input type="text">` with none of these signals scores zero, which
 * is what keeps the engine's plain-text path intact for genuine plain boxes.
 */
export function scoreComboboxShape(port: WidgetPort, target: WidgetTarget): Promise<number> {
  return port.evaluateOn(target.ref, (element) => {
    const editable =
      (element instanceof HTMLInputElement &&
        !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(element.type.toLowerCase())) ||
      element instanceof HTMLTextAreaElement ||
      element.isContentEditable;
    const role = element.getAttribute('role')?.toLowerCase() ?? '';
    const autocomplete = element.getAttribute('aria-autocomplete')?.toLowerCase() ?? '';
    const haspopup = element.getAttribute('aria-haspopup')?.toLowerCase() ?? '';
    const listAutocomplete = ['list', 'both', 'inline'].includes(autocomplete);

    if (role === 'combobox' && listAutocomplete) return 0.95;
    if (role === 'combobox') return 0.8;
    if (listAutocomplete) return 0.75;
    if (haspopup === 'listbox') return 0.7;

    // Weakest signal, and the only inferred one: an editable that declares it
    // controls a box, where that box is shaped like a list of choices. The
    // shape check matters — plenty of controls point `aria-controls` at a
    // status region or an error label, and driving one of those as a combobox
    // would type into the page and then rank the page's own error text.
    if (!editable) return 0;
    const ids = `${element.getAttribute('aria-controls') ?? ''} ${
      element.getAttribute('aria-owns') ?? ''
    }`
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    for (const id of ids) {
      const controlled = document.getElementById(id);
      if (!controlled) continue;
      const controlledRole = controlled.getAttribute('role')?.toLowerCase() ?? '';
      if (['listbox', 'menu', 'grid', 'tree'].includes(controlledRole)) return 0.6;
      if (controlled.querySelector('[role="option"],[role="menuitem"]')) return 0.6;
    }
    return 0;
  });
}

/**
 * Drive a suggestion control end to end.
 *
 * The choreography, in order: engage → find the editee → walk the query plan →
 * settle → rank against the **full** requested value → select → verify against
 * the chosen option → hand the release to the caller.
 *
 * What it deliberately does **not** do is decide whether unmatched free text is
 * an acceptable answer. The engine converts a `text` intent through
 * `asOptionIntent` before this driver sees it, which erases the distinction
 * between "free text is fine if it stands" and "a choice must be made". The
 * driver therefore reports what was offered and what survived release, and the
 * engine turns that into `typed_literal` or a failure.
 */
export const comboboxDriver: WidgetDriver = {
  kind: 'combobox',
  family: 'combobox',
  detect: scoreComboboxShape,
  drive: async (port, target, intent, budget): Promise<WidgetOutcome> => {
    if (intent.kind !== 'option') {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'intent-incompatible',
        'A combobox accepts only option intents.',
      );
    }
    if (port.now() > budget.deadlineMs || budget.maxActions < 1) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        'The widget action budget was exhausted.',
        { reason: 'budget' },
      );
    }

    const requested = intent.value;
    // A trigger that *declares* its popup has no pre-existing container to
    // ignore: whatever `aria-controls` points at is this widget's own list,
    // hidden right now and about to be shown. Only an undeclared control needs
    // the before-picture, so that an unrelated dialog it merely sits inside is
    // not read as its suggestions.
    const declaresPopup = await port.evaluateOn(
      target.ref,
      (element) =>
        element.hasAttribute('aria-controls') ||
        element.hasAttribute('aria-owns') ||
        element.hasAttribute('aria-haspopup') ||
        element.hasAttribute('aria-autocomplete'),
    );
    const ignoredContainer = declaresPopup
      ? null
      : await resolveContainer(port, target, { allowUnlinked: true });
    const queryForms = shapeQuery(requested);
    let live = target;
    let editee: WidgetTarget | null = null;
    let reformatted = false;

    const escalation = buildComboboxPlan({
      port,
      budget,
      forms: queryForms,
      runForm: async (context, form, index) => {
        // One baseline per drive, on the first form only. By the second form the
        // editee question is settled, so taking another observation pair would
        // pay twice to hear the same answer.
        const entered = await enterText(
          context.port,
          live,
          form.text,
          budget,
          index === 0 ? editeeProbe(context.port) : undefined,
        );
        if (entered.editee) {
          editee = entered.editee;
          live = entered.target;
        }
        reformatted = entered.typed.ok && entered.typed.reformatted;
        if (!entered.typed.ok) {
          return {
            ok: false,
            failure: widgetFailure(
              'WIDGET_NOT_COMMITTED',
              typingCause(entered.typed),
              entered.typed.message,
              {
                observed: entered.typed.observed,
                ...(entered.editee ? { editee: entered.editee.name } : {}),
                ...(entered.typed.reason === undefined ? {} : { reason: entered.typed.reason }),
              },
            ),
          };
        }

        // Ranking is against the full request, never the shortened form.
        const selection = await watchAndSelectOffered(context.port, live, requested, budget, {
          ignoredContainer: sameTarget(live, target) ? ignoredContainer : null,
        });

        if (selection.kind === 'no-suggestions' && index < queryForms.length - 1) {
          return {
            ok: false,
            failure: widgetFailure(
              'WIDGET_NOT_RECOGNIZED',
              'driver-not-recognized',
              `The query form "${form.kind}" produced no suggestions.`,
              { planTransient: true },
            ),
            evidence: { 'previous-form-no-suggestions': true },
          };
        }
        const outcome = toOutcome(context.port, live, requested, selection, {
          actions: chargedSoFar(budget, selection),
          editee,
          reformatted,
          container: selection.container,
        });
        const evidence = {
          'previous-form-no-suggestions': false,
          offered: 'offered' in selection ? selection.offered : [],
          ...('chosen' in selection ? { chosen: selection.chosen } : {}),
          ...('committed' in selection ? { committed: selection.committed } : {}),
          container: selection.container,
        };
        return outcome.ok
          ? { ok: true, value: outcome, evidence }
          : { ok: false, failure: outcome, evidence };
      },
    });
    const run = await runEscalationPlan(escalation);
    if (run.outcome === null) {
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        `No query form could be entered into "${target.name}" within the fill budget.`,
        { reason: 'budget' },
      );
    }
    return run.outcome.ok ? run.outcome.value : run.outcome.failure;
  },
};

/**
 * Select a specific label the widget already offered.
 *
 * The capability that makes the offered-label hint honest. A caller told to
 * "re-issue with one of those strings exactly as written" is answered by typing
 * a **distinguishing prefix** of that label and clicking the entry whose name
 * is the label — never by retyping the whole label, which a prefix-matching
 * autocomplete answers with nothing at all. That was the run's seq-24 trap: the
 * hint named a move the engine had no path for.
 */
export async function selectByOfferedLabel(
  port: WidgetPort,
  target: WidgetTarget,
  label: string,
  budget: Parameters<WidgetDriver['drive']>[3],
  others: readonly string[] = [],
): Promise<WidgetOutcome> {
  const prefix = distinguishingPrefix(label, others);
  const entered = await enterText(port, target, prefix, budget, editeeProbe(port));
  if (!entered.typed.ok) {
    return widgetFailure(
      'WIDGET_NOT_COMMITTED',
      typingCause(entered.typed),
      entered.typed.message,
      {
        observed: entered.typed.observed,
        ...(entered.editee ? { editee: entered.editee.name } : {}),
      },
    );
  }
  const live = entered.target;
  const selection = await watchAndSelectOffered(port, live, label, budget, {});
  return toOutcome(port, live, label, selection, {
    actions: chargedSoFar(budget, selection),
    editee: entered.editee,
    reformatted: entered.typed.ok && entered.typed.reformatted,
    container: selection.container,
  });
}

/** One settled read of whatever the control produced after typing. */
interface Reaction {
  readonly container: WidgetContainer | null;
  readonly ignored: boolean;
  readonly open: boolean;
  readonly candidates: readonly WidgetCandidate[];
  readonly semantics: WidgetChoiceSet['semantics'];
}

/**
 * What the widget did when it was asked to choose.
 *
 * Facts only. Which of these counts as an acceptable answer is the engine's
 * decision — see the note on {@link comboboxDriver}.
 */
export type OfferedSelection =
  /** One candidate ranked uniquely and was clicked. */
  | {
      readonly kind: 'selected';
      readonly chosen: string;
      readonly offered: readonly string[];
      readonly committed: string;
      readonly stillOpen: boolean;
      readonly actions: number;
      readonly container: WidgetContainer | null;
      readonly substitution?: ChoiceSubstitution;
    }
  /** A click landed but the control holds nothing. */
  | {
      readonly kind: 'not-committed';
      readonly chosen: string;
      readonly offered: readonly string[];
      readonly committed: string;
      readonly actions: number;
      readonly container: WidgetContainer | null;
    }
  /** Several ranked equally; the choice belongs to the caller. */
  | {
      readonly kind: 'ambiguous';
      readonly offered: readonly string[];
      readonly observed: string;
      readonly actions: number;
      readonly container: WidgetContainer | null;
    }
  /** A list was offered, nothing matched, and the typed text survived release. */
  | {
      readonly kind: 'unmatched-text-stands';
      readonly offered: readonly string[];
      readonly committed: string;
      readonly actions: number;
      readonly container: WidgetContainer | null;
    }
  /** A list was offered, nothing matched, and the page cleared the field. */
  | {
      readonly kind: 'text-discarded';
      readonly offered: readonly string[];
      readonly observed: string;
      readonly actions: number;
      readonly container: WidgetContainer | null;
      readonly semantics: WidgetChoiceSet['semantics'];
    }
  /** Nothing was offered at all; whatever the control holds is what it holds. */
  | {
      readonly kind: 'no-suggestions';
      readonly committed: string;
      readonly dismissed: boolean;
      readonly actions: number;
      readonly container: WidgetContainer | null;
    }
  /** There was no room left to click. */
  | {
      readonly kind: 'budget';
      readonly offered: readonly string[];
      readonly actions: number;
      readonly container: WidgetContainer | null;
    };

/** Scope for one selection pass. */
export interface SelectionScope {
  /**
   * A container that was already open before the fill began and is therefore
   * not this pass's to read as a suggestion list.
   */
  readonly ignoredContainer?: WidgetContainer | null | undefined;
}

/**
 * Watch for the list typing revealed, and commit its unique best candidate.
 *
 * **The single implementation of the selection stage.** The combobox driver
 * uses it as its own stage and the engine's plain-text path uses it for
 * offered-list discovery on controls no driver detected, so the two cannot
 * drift into different ideas of what a suggestion list said.
 *
 * @param requested - The **full requested value**, which is what candidates are
 *   ranked against — never the possibly-shortened text that was typed.
 */
export async function watchAndSelectOffered(
  port: WidgetPort,
  target: WidgetTarget,
  requested: string,
  budget: Parameters<WidgetDriver['drive']>[3],
  scope: SelectionScope = {},
): Promise<OfferedSelection> {
  const deadline = Math.min(budget.deadlineMs, port.now() + REACTION_WAIT_MS);
  const settled = await readWhenStable<Reaction>(
    () => readReaction(port, target, scope.ignoredContainer),
    (reaction) =>
      reaction.ignored
        ? 'ignored'
        : `${reaction.open ? 'open' : 'shut'}:${reaction.candidates.map((c) => c.name).join('\u0000')}`,
    {
      quietPolls: REACTION_QUIET_POLLS,
      pollMs: REACTION_POLL_MS,
      deadlineMs: deadline,
      now: () => port.now(),
      // An empty list is perfectly stable and says nothing. Holding out for
      // content is what lets a late autocomplete be seen at all.
      accept: (reaction) => reaction.ignored || reaction.candidates.length > 0,
    },
  );

  const reaction = settled.value;
  const container = reaction.container;
  if (
    reaction.ignored ||
    container === null ||
    !reaction.open ||
    reaction.candidates.length === 0
  ) {
    return {
      kind: 'no-suggestions',
      committed: await readCommitted(port, target),
      dismissed: false,
      actions: 0,
      container,
    };
  }

  const ranked = rankAgainstRequested(reaction.candidates, requested, container.path);
  const offered = reaction.candidates.slice(0, MAX_OFFERED).map((candidate) => candidate.name);

  if (ranked.kind === 'ambiguous') {
    await release(port);
    return {
      kind: 'ambiguous',
      offered: ranked.offered,
      observed: await readCommitted(port, target),
      actions: 0,
      container,
    };
  }

  if (ranked.kind === 'none') {
    await release(port);
    const observed = await readCommitted(port, target);
    // Whether this control will hold free text is not a judgement to make about
    // its markup — it is something the page answers by either keeping the text
    // or clearing it on release.
    return observed.trim().length > 0
      ? { kind: 'unmatched-text-stands', offered, committed: observed, actions: 0, container }
      : {
          kind: 'text-discarded',
          offered,
          observed,
          actions: 0,
          container,
          semantics: reaction.semantics,
        };
  }

  if (budget.maxActions < 2 || port.now() > budget.deadlineMs) {
    return { kind: 'budget', offered, actions: 0, container };
  }

  await clickCandidate(port, ranked.candidate);
  const committed = await readCommitted(port, target);
  if (committed.trim().length === 0) {
    return {
      kind: 'not-committed',
      chosen: ranked.candidate.name,
      offered,
      committed,
      actions: 1,
      container,
    };
  }
  return {
    kind: 'selected',
    chosen: ranked.candidate.name,
    offered,
    committed,
    stillOpen: await isOpen(port, target, container),
    actions: 1,
    container,
    ...(ranked.substitution ? { substitution: ranked.substitution } : {}),
  };
}

/** Turn a selection into the driver's own vocabulary. */
function toOutcome(
  port: WidgetPort,
  target: WidgetTarget,
  requested: string,
  selection: OfferedSelection,
  context: {
    readonly actions: number;
    readonly editee: WidgetTarget | null;
    readonly reformatted: boolean;
    readonly container: WidgetContainer | null;
  },
): WidgetOutcome {
  // No driver-local ledger. The runner owns records: each query form is a rung
  // whose `entryEvidence` names the form that was asked, and the typing ladder
  // inside it appends its own verdicts to the same sequence, in order.
  const editeeDetail = context.editee ? { editee: context.editee.name } : {};
  const container = context.container ?? undefined;

  switch (selection.kind) {
    case 'selected':
      return {
        ok: true,
        // Named for what the control turned out to be, not for the registry
        // entry that reached it: this is the value the caller has read as
        // `driver` since the disclosure contract landed.
        driver: 'typeahead',
        committed: selection.committed,
        actions: context.actions,
        chosen: selection.chosen,
        offered: selection.offered,
        ...(selection.substitution ? { substitution: selection.substitution } : {}),
        released: !selection.stillOpen,
        ...(context.editee ? { editee: context.editee } : {}),
        ...(container ? { container } : {}),
      };
    case 'unmatched-text-stands':
      // Reported, not judged: the engine decides whether standing text is an
      // answer, because `asOptionIntent` already erased the distinction.
      return {
        ok: true,
        driver: 'plain-text',
        committed: selection.committed,
        actions: context.actions,
        offered: selection.offered,
        // Nothing matched, so the list was released with Escape before the
        // field was re-read; that release is this driver's doing.
        released: true,
        ...(context.editee ? { editee: context.editee } : {}),
        ...(context.reformatted ? { reformatted: true } : {}),
        ...(container ? { container } : {}),
      };
    case 'no-suggestions':
      return {
        ok: true,
        driver: 'plain-text',
        committed: selection.committed,
        actions: context.actions,
        ...(context.editee ? { editee: context.editee } : {}),
        ...(context.reformatted ? { reformatted: true } : {}),
        ...(container ? { container } : {}),
      };
    case 'ambiguous':
      return widgetFailure(
        'WIDGET_AMBIGUOUS_CHOICE',
        'several-matched-equally',
        `"${target.name}" offers ${selection.offered.length} suggestions matching "${requested}" equally well, so none was chosen.`,
        {
          offered: selection.offered,
          observed: selection.observed,
          ...editeeDetail,
        },
      );
    case 'text-discarded':
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        selection.semantics === 'declared' ? 'no-suggestion-matched' : 'no-options-offered',
        `"${target.name}" offers no suggestion matching "${requested}" and discarded the typed text on release, so it will not accept a free-text value.`,
        {
          ...(selection.semantics === 'declared' ? { offered: selection.offered } : {}),
          observed: selection.observed,
          ...editeeDetail,
        },
      );
    case 'not-committed':
      return widgetFailure(
        'WIDGET_NOT_COMMITTED',
        'control-refused-value',
        `The suggestion "${selection.chosen}" was clicked, but "${target.name}" has no committed value.`,
        {
          committed: selection.committed,
          observed: selection.committed,
          offered: selection.offered,
          chosen: selection.chosen,
          ...editeeDetail,
        },
      );
    case 'budget':
      return widgetFailure(
        'WIDGET_TARGET_UNREACHABLE',
        'budget',
        'The fill action budget was exhausted before the suggestion could be selected.',
        { reason: 'budget', offered: selection.offered, ...editeeDetail },
      );
  }
  // `port` is part of the signature for symmetry with the other stages and to
  // keep future reads local; nothing here needs it.
  void port;
}

/** One read of the control's post-typing state. */
async function readReaction(
  port: WidgetPort,
  target: WidgetTarget,
  ignoredContainer: WidgetContainer | null | undefined,
): Promise<Reaction> {
  const container = await resolveContainer(port, target, { allowUnlinked: true });
  if (!container) {
    return { container: null, ignored: false, open: false, candidates: [], semantics: 'none' };
  }
  if (sameContainer(container, ignoredContainer)) {
    return { container, ignored: true, open: false, candidates: [], semantics: 'none' };
  }
  if (!(await isOpen(port, target, container))) {
    return { container, ignored: false, open: false, candidates: [], semantics: 'none' };
  }
  const choiceSet = await collectChoices(port, container);
  return {
    container,
    ignored: false,
    open: true,
    candidates: choiceSet.choices,
    semantics: choiceSet.semantics,
  };
}

/**
 * Why the typing ladder gave up, in the shared cause vocabulary.
 *
 * A delegated editee is not the same failure as a control that refused every
 * mechanism, and both arrive carrying `WIDGET_NOT_COMMITTED`. Naming the
 * distinction here is what lets the two read differently downstream.
 */
function typingCause(failure: TypingFailure): InteractionFailureCause {
  if (failure.editee !== undefined) return 'keystrokes-landed-elsewhere';
  if (failure.reason === 'budget') return 'budget';
  return 'typing-exhausted';
}

/**
 * What this drive has cost, taken from the one counter that knows.
 *
 * The runner charges every mutation through the shared run, so a driver-local
 * accumulator would be a second answer to the same question, drifting from the
 * first the moment a rung spends anything the driver did not perform itself.
 */
function chargedSoFar(
  budget: Parameters<WidgetDriver['drive']>[3],
  selection: OfferedSelection,
): number {
  return budget.run?.chargedActions ?? selection.actions;
}

/** Close whatever the typing opened, so the page is left in a clean state. */
async function release(port: WidgetPort): Promise<void> {
  await port.press('Escape');
  await sleep(REACTION_POLL_MS);
}

function sameContainer(left: WidgetContainer, right: WidgetContainer | null | undefined): boolean {
  return left.path.join('.') === right?.path.join('.');
}

function sameTarget(left: WidgetTarget, right: WidgetTarget): boolean {
  return left.ref === right.ref;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { AttemptLedger };
