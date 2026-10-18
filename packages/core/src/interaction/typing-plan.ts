/** The typing HOW ladder and WHERE recovery rung expressed as plan data. */

import type { AgentBrowserObservation } from '../browser/agent-controller.js';
import type { WidgetBudget, WidgetPort, WidgetTarget } from '../widgets/types.js';

import { locateEditee } from './editee.js';
import { asPlanBudget } from './escalation.js';
import type { EscalationPlan, Rung, RungOutcome } from './escalation.js';
import type { CommittedValue, WithheldValue } from './protected-value.js';
import {
  isTruncationOf,
  type EditeeProbeOptions,
  type TypedText,
  type TypingFailure,
  type TypingStrategy,
} from './typing.js';

/** Runtime operations injected to keep this builder declarative and cycle-free. */
export interface TypingPlanOperations {
  readonly apply: (
    port: WidgetPort,
    target: WidgetTarget,
    text: string,
    strategy: TypingStrategy,
  ) => Promise<void>;
  /** Reads the box, judging a protected control against `expected` inside the page. */
  readonly read: (
    port: WidgetPort,
    target: WidgetTarget,
    expected: string,
  ) => Promise<CommittedValue>;
  readonly targetHasFocus: (port: WidgetPort, target: WidgetTarget) => Promise<boolean>;
  /** Disclosed: same letters and numbers. Withheld: an `exact` or `reformatted` verdict. */
  readonly equivalent: (committed: CommittedValue, requested: string) => boolean;
  /** Disclosed: strictly fewer characters. Withheld: a `truncated` or `empty` verdict. */
  readonly truncated: (committed: CommittedValue, requested: string) => boolean;
}

export interface BuildTypingPlanInput {
  readonly port: WidgetPort;
  readonly target: WidgetTarget;
  readonly text: string;
  readonly budget: WidgetBudget;
  readonly allowEscalation: boolean;
  readonly probe?: EditeeProbeOptions;
  readonly before: AgentBrowserObservation | null;
  readonly operations: TypingPlanOperations;
}

/** Build the one ordered policy for text entry. This function reads no page state. */
export function buildTypingPlan(
  input: BuildTypingPlanInput,
): EscalationPlan<TypedText, TypingFailure, WidgetPort> {
  /** The latest read, so a WHERE failure reports what the control held. */
  let lastRead: CommittedValue = { kind: 'disclosed', text: '' };
  const strategyRung = (
    strategy: TypingStrategy,
    entry: Rung<TypedText, TypingFailure, WidgetPort>['entry'],
    maxActions: number,
  ): Rung<TypedText, TypingFailure, WidgetPort> => ({
    id: strategy,
    axis: 'how',
    entry,
    costCap: { maxActions },
    produces: ['committed', 'committed-successfully', 'last-strategy-failure'],
    run: async ({ port }): Promise<RungOutcome<TypedText, TypingFailure>> => {
      await input.operations.apply(port, input.target, input.text, strategy);
      // A secret commits blind. The absence of a read here is the security
      // property; neither the outcome nor the verdict carries secret evidence.
      if (!input.allowEscalation) {
        return {
          ok: true,
          value: successful(strategy, null, false),
        };
      }
      const committed = await input.operations.read(port, input.target, input.text);
      lastRead = committed;
      if (input.operations.equivalent(committed, input.text)) {
        return {
          ok: true,
          value: successful(
            strategy,
            committed,
            committed.kind === 'disclosed'
              ? committed.text !== input.text
              : committed.match === 'reformatted',
          ),
          evidence: {
            committed,
            'committed-successfully': true,
            'last-strategy-failure': null,
          },
        };
      }
      return {
        ok: false,
        failure: failed(input.target, committed, input.text),
        evidence: {
          committed,
          'committed-successfully': false,
          'last-strategy-failure': strategy,
        },
      };
    },
  });

  const overtype = strategyRung('overtype', () => ({ enter: true, evidence: [] }), 1);
  if (!input.allowEscalation) {
    return plan(input, [overtype]);
  }

  const locate: Rung<TypedText, TypingFailure, WidgetPort> = {
    id: 'locate-editee',
    axis: 'where',
    entry: (evidence) => {
      if (evidence.values['committed-successfully'] === true) {
        return { enter: false, unmet: 'already-committed' };
      }
      if (evidence.values['last-strategy-failure'] !== 'overtype') {
        return { enter: false, unmet: 'no-replacement-signal' };
      }
      if (holdsSomething(evidence.values.committed)) {
        return { enter: false, unmet: 'control-not-empty' };
      }
      if (!input.probe || input.before === null) {
        return { enter: false, unmet: 'no-baseline-observation' };
      }
      return { enter: true, evidence: ['control-empty', 'baseline-observation'] };
    },
    costCap: { maxActions: 0 },
    produces: ['editee-located', 'editee-evidence'],
    run: async ({ port }) => {
      const after = await input.probe!.observe();
      const retainedFocus = await input.operations.targetHasFocus(port, input.target);
      const located = locateEditee(input.before!, after, input.target, input.text, {
        targetRetainedFocus: retainedFocus,
      });
      if (located.kind === 'delegated') {
        return {
          ok: false,
          failure: {
            ok: false,
            errorCode: 'WIDGET_NOT_COMMITTED',
            message: `The "${input.target.name}" control is still empty because the page routed the typed value to "${located.target.name}" instead.`,
            observed: lastRead,
            editee: located.target,
            editeeEvidence: located.evidence,
            attempted: [],
          },
          evidence: {
            'editee-located': true,
            'editee-evidence': located.evidence,
          },
        };
      }
      return {
        ok: false,
        failure: failed(input.target, lastRead, input.text),
        evidence: {
          'editee-located': false,
          'editee-evidence': located.kind === 'same' ? 'none' : located.evidence,
        },
      };
    },
  };

  const retryEntry: Rung<TypedText, TypingFailure, WidgetPort>['entry'] = (evidence) => {
    if (evidence.values['committed-successfully'] === true) {
      return { enter: false, unmet: 'already-committed' };
    }
    if (evidence.values['editee-located'] === true) {
      return { enter: false, unmet: 'editee-located' };
    }
    return { enter: true, evidence: ['previous-mechanism-failed'] };
  };
  const clear = strategyRung('clear-then-type', retryEntry, 2);
  const native = strategyRung(
    'native-setter',
    (evidence) => {
      if (evidence.values['committed-successfully'] === true) {
        return { enter: false, unmet: 'already-committed' };
      }
      if (evidence.values['editee-located'] === true) {
        return { enter: false, unmet: 'editee-located' };
      }
      if (evidence.values['last-strategy-failure'] !== 'clear-then-type') {
        return { enter: false, unmet: 'previous-mechanism-not-failed' };
      }
      return { enter: true, evidence: ['previous-mechanism-failed'] };
    },
    3,
  );
  return plan(input, [overtype, locate, clear, native]);
}

function plan(
  input: BuildTypingPlanInput,
  rungs: readonly Rung<TypedText, TypingFailure, WidgetPort>[],
): EscalationPlan<TypedText, TypingFailure, WidgetPort> {
  return {
    family: 'text',
    operation: 'commit-text',
    rungs,
    // The run rides through: a typing ladder invoked inside a fill spends that
    // fill's allowance and appends to its one sequence, rather than opening a
    // fresh ceiling of its own at every nesting level.
    budget: asPlanBudget(input.budget),
    port: input.port,
    now: () => input.port.now(),
    // Typing failures are eligibility evidence. Later rungs decide whether a
    // different mechanism is warranted; the shared runner remains the loop.
    classify: () => 'transient',
  };
}

function successful(
  strategy: TypingStrategy,
  committed: CommittedValue | null,
  reformatted: boolean,
): TypedText {
  return { ok: true, strategy, committed, reformatted, attempted: [] };
}

/**
 * Whether the last read found anything in the control.
 *
 * A protected control answers through `present`, never through its text, so a
 * withheld box that kept nothing reads as empty here exactly as a disclosed one
 * does.
 */
function holdsSomething(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const read = value as CommittedValue;
  return read.kind === 'disclosed' ? read.text.length > 0 : read.present;
}

function failed(target: WidgetTarget, committed: CommittedValue, requested: string): TypingFailure {
  return {
    ok: false,
    errorCode: 'WIDGET_NOT_COMMITTED',
    message:
      committed.kind === 'withheld'
        ? withheldMessage(target, committed)
        : committed.text.length === 0
          ? `The "${target.name}" control is still empty after the value was typed.`
          : isTruncationOf(committed.text, requested)
            ? `The "${target.name}" control kept only "${committed.text}" of the value that was typed.`
            : `The "${target.name}" control changed the typed value to unrelated text "${committed.text}".`,
    observed: committed,
    attempted: [],
  };
}

/**
 * The failure sentence for a protected control. It names the in-page verdict
 * and never quotes, measures, or hashes the value.
 */
export function withheldMessage(target: WidgetTarget, value: WithheldValue): string {
  const found =
    value.match === 'truncated'
      ? 'kept fewer characters than were typed'
      : value.match === 'different'
        ? 'holds a different value'
        : value.match === null
          ? 'could not be compared with what was typed'
          : value.match === 'empty'
            ? 'is still empty'
            : 'holds the value';
  return `The "${target.name}" control withholds its contents; a check inside the page found it ${found}.`;
}
