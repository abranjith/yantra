import { attributeForLong } from './flags.js';
import type { Condition, ExecutionClass, LeafEntry } from './schema.js';

/** What a condition can observe about one parsed invocation. */
export interface InvocationFacts {
  /** Parsed option values keyed by commander attribute (as `opts()` returns them). */
  readonly options: Readonly<Record<string, unknown>>;
  /** Parsed argument values keyed by argument name. */
  readonly arguments: Readonly<Record<string, unknown>>;
  /**
   * Attributes the user actually set. When given, `present` means "set by the
   * user"; when absent, it falls back to the value: `false` for a `--no-x`
   * option, and otherwise defined and not `false`.
   */
  readonly explicit?: readonly string[];
  /** The resolved mode, when known. Otherwise `--no-llm` (`llm: false`) means deterministic. */
  readonly mode?: 'llm' | 'deterministic';
}

/** Structural equality over JSON-shaped values. */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => jsonEqual(item, right[i]));
  }
  if (
    typeof left === 'object' &&
    typeof right === 'object' &&
    left !== null &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return (
      keys.length === Object.keys(rightRecord).length &&
      keys.every((key) => key in rightRecord && jsonEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

/** Evaluates one registry condition against an invocation. Pure. */
export function conditionHolds(condition: Condition, facts: InvocationFacts): boolean {
  if ('mode' in condition) {
    const mode = facts.mode ?? (facts.options.llm === false ? 'deterministic' : 'llm');
    return mode === condition.mode;
  }
  if ('argument' in condition) {
    const value = facts.arguments[condition.argument];
    return typeof value === 'string' && (condition.in as readonly string[]).includes(value);
  }
  const attribute = attributeForLong(condition.option);
  const value = facts.options[attribute];
  if ('equals' in condition) return jsonEqual(value, condition.equals);
  if (facts.explicit !== undefined) return facts.explicit.includes(attribute);
  // A set `--no-x` stores `false`; an unset one holds commander's implicit `true`.
  if (condition.option.startsWith('--no-')) return value === false;
  return value !== undefined && value !== false;
}

/**
 * The execution class of one invocation: the first rule whose condition holds,
 * otherwise the entry's default. Pure.
 *
 * @example
 * // doctor: read by default, run with --agent-smoke
 * executionClassFor(doctor, { options: { agentSmoke: true }, arguments: {} }); // 'run'
 */
export function executionClassFor(
  entry: Pick<LeafEntry, 'execution'>,
  facts: InvocationFacts,
): ExecutionClass {
  for (const rule of entry.execution.rules) {
    if (conditionHolds(rule.when, facts)) return rule.class;
  }
  return entry.execution.default;
}
