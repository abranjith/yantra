/**
 * Pure structural resolution for choices whose model-visible labels tie.
 *
 * The helper deliberately knows nothing about widgets or browser ports. Callers
 * supply the exact label they would expose in `offered` and, when available,
 * the path of the container they have already resolved.
 */

import type { VerdictEvidence } from './escalation.js';
import { normalizeText } from './types.js';

/** A structural rung that narrowed an otherwise tied choice set. */
export type ChoiceTieBreakRung =
  | 'within-container'
  | 'enabled-and-visible'
  | 'page-selected'
  | 'document-order';

/** The structural facts shared by candidates that may be tie-broken. */
export interface StructuralChoice {
  readonly path: readonly number[];
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly selected?: boolean;
}

/** Disclosure for a choice made because every survivor looked identical. */
export interface ChoiceSubstitution {
  readonly indistinguishable: number;
  readonly position: number;
  readonly tieBreak: readonly ChoiceTieBreakRung[];
  readonly label: string;
}

/**
 * The rung evidence disclosing a structural substitution.
 *
 * A count, a position and the rungs that narrowed the pool — never the shared
 * label, which is the one thing that could not distinguish them anyway and is
 * page text besides. `FillSuccess.substitution` remains the full disclosure.
 */
export function substitutionEvidence(substitution: ChoiceSubstitution): VerdictEvidence {
  return {
    substituted: substitution.indistinguishable,
    substitution_position: substitution.position,
    tie_break: substitution.tieBreak.join(','),
  };
}

/** Result of structurally resolving a set of model-visible choices. */
export type ChoiceOutcome<TChoice> =
  | {
      readonly kind: 'unique';
      readonly choice: TChoice;
      readonly tieBreak: readonly ChoiceTieBreakRung[];
    }
  | {
      readonly kind: 'substituted';
      readonly choice: TChoice;
      readonly substitution: ChoiceSubstitution;
    }
  | { readonly kind: 'ambiguous'; readonly survivors: readonly TChoice[] }
  | { readonly kind: 'none' };

/** Caller-owned projections and scope for structural choice resolution. */
export interface ResolveChoiceOptions<TChoice> {
  /** Exactly the string this candidate would contribute to `offered`. */
  readonly label: (choice: TChoice) => string;
  /** The already-resolved container path, when the caller has one. */
  readonly containerPath?: readonly number[];
  /** Model-visible identity normalization; defaults to {@link normalizeText}. */
  readonly normalize?: (value: string) => string;
}

/**
 * Resolve indistinguishable choices using only container and DOM structure.
 *
 * A rung filters only when it leaves at least one candidate and genuinely
 * narrows the pool. Differently-labelled survivors are always returned to the
 * caller; document order is used only when the model cannot distinguish them.
 */
export function resolveIndistinguishableChoice<TChoice extends StructuralChoice>(
  candidates: readonly TChoice[],
  options: ResolveChoiceOptions<TChoice>,
): ChoiceOutcome<TChoice> {
  if (candidates.length === 0) return { kind: 'none' };

  const tieBreak: ChoiceTieBreakRung[] = [];
  let pool = candidates;

  const apply = (rung: ChoiceTieBreakRung, next: readonly TChoice[]): void => {
    if (next.length === 0 || next.length === pool.length) return;
    pool = next;
    tieBreak.push(rung);
  };

  if (options.containerPath !== undefined) {
    apply(
      'within-container',
      pool.filter((choice) => pathStartsWith(choice.path, options.containerPath!)),
    );
  }
  if (pool.length === 1) return { kind: 'unique', choice: pool[0]!, tieBreak };

  apply(
    'enabled-and-visible',
    pool.filter((choice) => choice.disabled !== true && choice.hidden !== true),
  );
  if (pool.length === 1) return { kind: 'unique', choice: pool[0]!, tieBreak };

  apply(
    'page-selected',
    pool.filter((choice) => choice.selected === true),
  );
  if (pool.length === 1) return { kind: 'unique', choice: pool[0]!, tieBreak };

  const normalize = options.normalize ?? normalizeText;
  const firstLabel = normalize(options.label(pool[0]!));
  if (pool.some((choice) => normalize(options.label(choice)) !== firstLabel)) {
    return { kind: 'ambiguous', survivors: pool };
  }

  const ordered = [...pool].sort((left, right) => comparePaths(left.path, right.path));
  tieBreak.push('document-order');
  return {
    kind: 'substituted',
    choice: ordered[0]!,
    substitution: {
      indistinguishable: pool.length,
      position: 1,
      tieBreak,
      label: options.label(ordered[0]!),
    },
  };
}

function pathStartsWith(path: readonly number[], prefix: readonly number[]): boolean {
  return prefix.length <= path.length && prefix.every((part, index) => path[index] === part);
}

function comparePaths(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}
