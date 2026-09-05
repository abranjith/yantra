/** The typing HOW ladder and WHERE recovery rung expressed as plan data. */

import type { AgentBrowserObservation } from '../browser/agent-controller.js';
import type { WidgetBudget, WidgetPort, WidgetTarget } from '../widgets/types.js';

import { locateEditee } from './editee.js';
import { asPlanBudget } from './escalation.js';
import type { EscalationPlan, Rung, RungOutcome } from './escalation.js';
import type { EditeeProbeOptions, TypedText, TypingFailure, TypingStrategy } from './typing.js';

/** Runtime operations injected to keep this builder declarative and cycle-free. */
export interface TypingPlanOperations {
  readonly apply: (
    port: WidgetPort,
    target: WidgetTarget,
    text: string,
    strategy: TypingStrategy,
  ) => Promise<void>;
  readonly read: (port: WidgetPort, target: WidgetTarget) => Promise<string>;
  readonly targetHasFocus: (port: WidgetPort, target: WidgetTarget) => Promise<boolean>;
  readonly equivalent: (committed: string, requested: string) => boolean;
  readonly truncated: (committed: string, requested: string) => boolean;
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
          value: successful(strategy, '', false),
        };
      }
      const committed = await input.operations.read(port, input.target);
      if (input.operations.equivalent(committed, input.text)) {
        return {
          ok: true,
          value: successful(strategy, committed, committed !== input.text),
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
      if (typeof evidence.values.committed === 'string' && evidence.values.committed.length > 0) {
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
            observed: '',
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
        failure: failed(input.target, '', input.text),
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

function successful(strategy: TypingStrategy, committed: string, reformatted: boolean): TypedText {
  return { ok: true, strategy, committed, reformatted, attempted: [] };
}

function failed(target: WidgetTarget, committed: string, requested: string): TypingFailure {
  return {
    ok: false,
    errorCode: 'WIDGET_NOT_COMMITTED',
    message:
      committed.length === 0
        ? `The "${target.name}" control is still empty after the value was typed.`
        : isTruncation(committed, requested)
          ? `The "${target.name}" control kept only "${committed}" of the value that was typed.`
          : `The "${target.name}" control changed the typed value to unrelated text "${committed}".`,
    observed: committed,
    attempted: [],
  };
}

function isTruncation(committed: string, requested: string): boolean {
  const actual = committed.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const wanted = requested.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (wanted.length === 0 || actual.length >= wanted.length) return false;
  let cursor = 0;
  for (const character of wanted) {
    if (character === actual[cursor]) cursor += 1;
    if (cursor === actual.length) return true;
  }
  return actual.length === 0;
}
