/**
 * The engine-owned open stage.
 *
 * **Detection never clicks.** That rule is what makes `detect()` safe to run
 * across every registered driver — a driver that opened a widget while deciding
 * whether it applied would toggle pickers the caller never addressed. It is not
 * negotiable, and this module does not weaken it.
 *
 * But some controls tell you nothing until they are opened. A bare textbox that
 * mounts its calendar on click carries no `aria-haspopup`, no `type="date"`, no
 * format hint and no rendered value, so every date driver scores it zero and
 * the fill fails with "no date widget driver recognized it". In the run that
 * motivated this, the agent answered that failure by driving the calendar by
 * hand: eleven `browser_click` calls, about thirty-five seconds of wall time
 * and eleven model round-trips, doing what `calendarDriver` does in one call.
 *
 * So the click moves **out** of detection and into a separate stage the engine
 * owns explicitly, with its own entry condition, a single bounded attempt and a
 * mandatory drive-or-dismiss. One probe per fill.
 *
 * It owns the open, the container wait and the dismiss; **driving** what it
 * revealed belongs to the caller, which runs those candidates as a sub-plan on
 * the shared run. That is what makes `driver:<kind>` arrive as a verdict in the
 * one sequence instead of as a driver-local ledger spliced in afterwards.
 */

import {
  isOpen,
  resolveContainer,
  OPEN_WAIT_MS,
  POLL_MS,
  type WidgetContainer,
} from './open-state.js';
import type { DetectedWidgetDriver } from './registry.js';
import {
  widgetFailure,
  type WidgetBudget,
  type WidgetFailure,
  type WidgetFamily,
  type WidgetIntent,
  type WidgetOutcome,
  type WidgetPort,
  type WidgetTarget,
} from './types.js';

/** What the probe did. */
export type ProbeOutcome =
  /** The entry condition did not hold; nothing was clicked. */
  | { readonly kind: 'skipped'; readonly reason: ProbeSkipReason }
  /** A driver recognised the open state and the caller drove it. */
  | {
      readonly kind: 'driven';
      readonly outcome: WidgetOutcome;
      /** The registry driver **kind** opening revealed. Never page text. */
      readonly revealedDriver: string;
    }
  /** The probe opened something, or nothing, and no driver recognised it. */
  | { readonly kind: 'unrecognized'; readonly failure: WidgetFailure };

/** Why a probe did not run. A fixed enum; it carries no page text. */
export type ProbeSkipReason = 'budget' | 'semantics-disagree';

/** What the probe needs from its caller. */
export interface OpenProbeOptions {
  /** The semantic operation, which the field's own shape has to agree with. */
  readonly intent: WidgetIntent;
  /**
   * Detection, injected rather than imported.
   *
   * The registry is the engine's to own — this stage is a procedure over it,
   * not a second place drivers are registered — and injecting it keeps the
   * probe testable with a fixed driver set.
   */
  readonly detect: (
    port: WidgetPort,
    target: WidgetTarget,
    family: WidgetFamily,
  ) => Promise<readonly DetectedWidgetDriver[]>;
  /**
   * Detection against the container this stage revealed.
   *
   * The reason the probe exists: a driver that scores a closed bare textbox
   * zero — correctly — recognises the month grid behind it instantly. Without
   * this the probe could open the calendar and still have nothing able to drive
   * it, which is the failure it was built to remove.
   */
  readonly detectOpen: (
    port: WidgetPort,
    target: WidgetTarget,
    container: WidgetContainer,
    family: WidgetFamily,
  ) => Promise<readonly DetectedWidgetDriver[]>;
  /**
   * Drive what opening revealed, as a sub-plan on the caller's run.
   *
   * The probe owns the open and the dismiss; it deliberately does not own the
   * drive. Handing the revealed candidates back is what lets them run through
   * the ordinary family plan, so each one appears as its own `driver:<kind>`
   * verdict in the caller's single sequence.
   */
  readonly drive: (
    candidates: readonly DetectedWidgetDriver[],
    port: WidgetPort,
  ) => Promise<WidgetOutcome>;
}

/**
 * Form vocabulary that says a control is about dates.
 *
 * Generic English form words, never a site's naming. A field labelled
 * "Departure" is a date field on every travel site ever built and on none of
 * them in particular; that is exactly the kind of signal this rule is allowed
 * to read.
 */
const DATE_WORDS =
  /(?:date|day|month|year|depart|arriv|return|check\s*-?\s*(?:in|out)|when|calendar)/i;

/** A rendered date, in the numeric or textual forms a trigger commonly shows. */
const RENDERED_DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}/i;

/**
 * Whether the field's own shape agrees with what the caller is asking of it.
 *
 * Exported so the entry condition can be tested on its own: a probe that runs
 * where it should not is a click on a control nobody asked to open, and that is
 * a different defect from a probe that opens the right thing and reads it
 * wrongly.
 *
 * A date intent needs a control text can plausibly be entered into or that
 * looks like a date trigger. An option intent needs a control that says it
 * opens something — a plain text box asked for an option is a text box, and
 * clicking it would achieve nothing but a click.
 */
export async function shouldProbeOpen(
  port: WidgetPort,
  target: WidgetTarget,
  intent: WidgetIntent,
): Promise<boolean> {
  const shape = await port.evaluateOn(target.ref, (element) => {
    const input = element instanceof HTMLInputElement ? element : null;
    const type = input?.type.toLowerCase() ?? '';
    return {
      textLike:
        element instanceof HTMLTextAreaElement ||
        (input !== null && !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)),
      hint: [
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('placeholder') ?? '',
        element.getAttribute('title') ?? '',
        input?.value ?? element.textContent ?? '',
      ].join(' '),
      declaresPopup:
        element.hasAttribute('aria-haspopup') ||
        element.hasAttribute('aria-controls') ||
        element.hasAttribute('aria-owns') ||
        element.getAttribute('aria-expanded') !== null,
    };
  });
  const named = `${target.name} ${shape.hint}`;

  if (intent.kind === 'date' || intent.kind === 'date_range') {
    // A date asked of a text-like control is the shape that motivated this
    // stage: the calendar is behind a click and nothing about the closed
    // control says so. A non-typeable trigger still qualifies when it is named
    // or rendered as a date, or when it declares that it opens something.
    return shape.textLike || DATE_WORDS.test(named) || RENDERED_DATE.test(named);
  }
  return shape.declaresPopup;
}

/**
 * Open the control once, re-detect against the open state, and drive or dismiss.
 *
 * Runs only after the family's detection came back empty — the caller checks
 * that; this function checks the field's own semantics. Whatever it opens it
 * either drives or closes again, so a page is never left with an overlay across
 * it because a probe walked away.
 */
export async function probeOpen(
  port: WidgetPort,
  target: WidgetTarget,
  family: WidgetFamily,
  budget: WidgetBudget,
  options: OpenProbeOptions,
): Promise<ProbeOutcome> {
  if (port.now() > budget.deadlineMs || budget.maxActions < 2) {
    return { kind: 'skipped', reason: 'budget' };
  }
  if (!(await shouldProbeOpen(port, target, options.intent))) {
    return { kind: 'skipped', reason: 'semantics-disagree' };
  }

  await port.click(target.ref);
  const container = await waitForContainer(port, target, budget);

  const candidates =
    container === null
      ? await options.detect(port, target, family)
      : [
          ...(await options.detectOpen(port, target, container, family)),
          ...(await options.detect(port, target, family)),
        ];
  if (candidates.length > 0) {
    // The probe and the drive stay two separate facts, but they are now two
    // verdicts on one sequence rather than two hand-built records: this rung
    // discloses which driver opening revealed, and the drive runs as a sub-plan
    // that appends its own.
    return {
      kind: 'driven',
      outcome: await options.drive(candidates, port),
      revealedDriver: candidates[0]!.driver.kind,
    };
  }

  // Drive or dismiss. Leaving an unrecognised popup standing hands the caller a
  // page with an overlay across it and no way to know this call put it there.
  const seen = container === null ? emptyReading() : await readOpened(port, container.path);
  await dismiss(port);
  return {
    kind: 'unrecognized',
    failure: widgetFailure(
      'WIDGET_TARGET_UNREACHABLE',
      container === null ? 'picker-did-not-open' : 'driver-not-recognized',
      container === null
        ? `Opening "${target.name}" revealed no widget container, so there is nothing for a ${family} driver to operate.`
        : `Opening "${target.name}" revealed a container no ${family} driver recognised, so it was closed again.`,
      {
        containerResolved: container !== null,
        cellsSeen: seen.cells,
        optionsSeen: seen.options,
        monthsSeen: seen.months,
      },
      false,
    ),
  };
}

/** Poll for a container the click revealed, within the shared open budget. */
async function waitForContainer(
  port: WidgetPort,
  target: WidgetTarget,
  budget: WidgetBudget,
): Promise<WidgetContainer | null> {
  const deadline = Math.min(budget.deadlineMs, port.now() + OPEN_WAIT_MS);
  for (;;) {
    const container = await resolveContainer(port, target, { allowUnlinked: true });
    if (container && (await isOpen(port, target, container))) return container;
    if (port.now() >= deadline) return null;
    await sleep(POLL_MS);
  }
}

/** What the opened container actually contained, for the failure to carry. */
async function readOpened(
  port: WidgetPort,
  path: readonly number[],
): Promise<{ readonly cells: number; readonly options: number; readonly months: number }> {
  return port.evaluate((containerPath) => {
    let current: Element | null = document.documentElement;
    for (const index of containerPath) current = current?.children.item(index) ?? null;
    if (!(current instanceof HTMLElement)) return { cells: 0, options: 0, months: 0 };
    return {
      cells: current.querySelectorAll('[role="gridcell"],td').length,
      options: current.querySelectorAll('[role="option"],[role="menuitem"]').length,
      months: current.querySelectorAll('table,[role="grid"]').length,
    };
  }, path);
}

function emptyReading(): {
  readonly cells: number;
  readonly options: number;
  readonly months: number;
} {
  return { cells: 0, options: 0, months: 0 };
}

/** Close whatever the probe opened. */
async function dismiss(port: WidgetPort): Promise<void> {
  await port.press('Escape');
  await sleep(POLL_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
