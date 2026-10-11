/**
 * The expectation ledger and its owner ratchet (FEAT-049 TASK-006).
 *
 * Every deterministic expectation names the feature that owns the capability
 * it measures. A capability whose owner has not landed is pinned at its
 * observed **baseline** — a characterization of today's behavior ("the
 * results page was fetched 3 times", "`records` is absent"), never a vague
 * "fails" — and its **target** is evaluated too. When the target already
 * holds, the suite fails and names the owner to flip, so a landed capability
 * cannot go unnoticed. When the owner lands, it removes itself from
 * {@link PENDING_OWNERS}, deletes its baselines, and its targets become live
 * and gating. That one set is the only switch.
 */

import type { ScenarioRun } from './runner.js';
import type { Scenario } from './scenario.js';

/** Every legal owner. `current` means "holds today and must keep holding". */
export const OWNERS = [
  'current',
  'FEAT-048',
  'FEAT-050',
  'FEAT-051',
  'FEAT-052',
  'FEAT-053',
] as const;

export type Owner = (typeof OWNERS)[number];

/**
 * Owners whose capability has not landed. Their expectations assert the
 * baseline; their targets must still fail.
 *
 * To land an owner: remove it here, delete every baseline it owns, and run the
 * deterministic tier. A target that then fails is fixed in the owner's code,
 * never by editing the expectation.
 */
export const PENDING_OWNERS: ReadonlySet<Owner> = new Set<Owner>([
  'FEAT-050',
  'FEAT-051',
  'FEAT-052',
  'FEAT-053',
]);

/** The verdict of one matcher on one measured value. */
export interface MatchResult {
  readonly pass: boolean;
  /** One line: what was expected and what was measured. */
  readonly message: string;
}

/** A small, typed, printable predicate over a measured value. */
export interface Matcher {
  /** One line describing what passes, e.g. `equals 3`. */
  readonly description: string;
  test(value: unknown): MatchResult;
}

/** One measurement of a completed run, owned by one feature. */
export interface Expectation {
  /** Unique within its scenario. */
  readonly id: string;
  readonly owner: Owner;
  /** A pure read of the completed run. */
  readonly measure: (run: ScenarioRun) => unknown;
  /** The contract the owner must meet. */
  readonly target: Matcher;
  /** Today's characterized behavior: required while the owner is pending, forbidden otherwise. */
  readonly baseline?: Matcher;
  /** One line naming the plan gap (`G2`, `G10`, …) or §11 row this pins. */
  readonly note: string;
}

const MAX_SHOWN = 300;

/** A compact, bounded rendering of a measured value for failure output. */
export function show(value: unknown): string {
  let text: string;
  try {
    // JSON.stringify yields undefined for undefined, functions, and symbols.
    text = JSON.stringify(value) ?? `<${typeof value}>`;
  } catch {
    // swallow-ok: a value JSON cannot render (a cycle, a bigint) is still named.
    text = `<unserializable ${typeof value}>`;
  }
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}… (${text.length} chars)` : text;
}

function matcher(description: string, predicate: (value: unknown) => boolean): Matcher {
  return {
    description,
    test: (value) => {
      const pass = predicate(value);
      return { pass, message: `expected ${description}; measured ${show(value)}` };
    },
  };
}

/** Deep structural equality. */
export function equals(expected: unknown): Matcher {
  return matcher(`equals ${show(expected)}`, (value) => deepEqual(value, expected));
}

/** A number at least `minimum`. */
export function atLeast(minimum: number): Matcher {
  return matcher(`a number ≥ ${minimum}`, (value) => typeof value === 'number' && value >= minimum);
}

/** A number at most `maximum`. */
export function atMost(maximum: number): Matcher {
  return matcher(`a number ≤ ${maximum}`, (value) => typeof value === 'number' && value <= maximum);
}

/** An array (or string) containing every one of `items`. */
export function includesAll(items: readonly unknown[]): Matcher {
  return matcher(`includes all of ${show(items)}`, (value) =>
    typeof value === 'string'
      ? items.every((item) => typeof item === 'string' && value.includes(item))
      : Array.isArray(value) &&
        items.every((item) => value.some((entry) => deepEqual(entry, item))),
  );
}

/** An array (or string) containing none of `items`. */
export function excludesAll(items: readonly unknown[]): Matcher {
  return matcher(`excludes all of ${show(items)}`, (value) =>
    typeof value === 'string'
      ? items.every((item) => typeof item !== 'string' || !value.includes(item))
      : Array.isArray(value) &&
        items.every((item) => !value.some((entry) => deepEqual(entry, item))),
  );
}

/**
 * A value structurally containing `shape`: every key of an object shape must
 * match, recursively; an array shape must match element for element.
 */
export function matchesShape(shape: unknown): Matcher {
  return matcher(`matches shape ${show(shape)}`, (value) => containsShape(value, shape));
}

/** An array whose every element satisfies `predicate` (vacuously true when empty). */
export function everyLine(description: string, predicate: (line: unknown) => boolean): Matcher {
  return matcher(`every line ${description}`, (value) =>
    Array.isArray(value) ? value.every((line) => predicate(line)) : false,
  );
}

/**
 * A value satisfying a named predicate — for a contract the small matchers
 * cannot state alone (e.g. "one citation list per comparison row").
 */
export function satisfies(description: string, predicate: (value: unknown) => boolean): Matcher {
  return matcher(description, (value) => predicate(value));
}

/** An array whose length satisfies `expected` (a number, or another matcher). */
export function count(expected: number | Matcher): Matcher {
  const inner = typeof expected === 'number' ? equals(expected) : expected;
  return {
    description: `a list whose length ${inner.description}`,
    test: (value) => {
      if (!Array.isArray(value)) {
        return { pass: false, message: `expected a list; measured ${show(value)}` };
      }
      const verdict = inner.test(value.length);
      return {
        pass: verdict.pass,
        message: `expected a list whose length ${inner.description}; measured ${value.length}: ${show(value)}`,
      };
    },
  };
}

/** The verdict on one expectation against one run, under a given pending set. */
export interface ExpectationVerdict {
  readonly pass: boolean;
  /** Which matcher was asserted. */
  readonly asserted: 'target' | 'baseline';
  readonly message: string;
}

/**
 * Evaluate one expectation: the target for a landed owner, the baseline for a
 * pending one — plus the flip check, which fails a pending expectation whose
 * target already holds. A measure that throws fails loudly; a baseline is a
 * characterization and cannot pass vacuously on a crash.
 *
 * @param run The completed run.
 * @param expectation The expectation.
 * @param pending The pending-owner set (the real one unless a test substitutes).
 */
export function evaluateExpectation(
  run: ScenarioRun,
  expectation: Expectation,
  pending: ReadonlySet<Owner> = PENDING_OWNERS,
): ExpectationVerdict {
  let measured: unknown;
  try {
    measured = expectation.measure(run);
  } catch (error) {
    return {
      pass: false,
      asserted: isPending(expectation.owner, pending) ? 'baseline' : 'target',
      message: `${expectation.id}: the measure threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isPending(expectation.owner, pending)) {
    const verdict = expectation.target.test(measured);
    return {
      pass: verdict.pass,
      asserted: 'target',
      message: `${expectation.id}: ${verdict.message}`,
    };
  }
  if (expectation.baseline === undefined) {
    return {
      pass: false,
      asserted: 'baseline',
      message: `${expectation.id}: ${expectation.owner} is pending, so this expectation needs a baseline.`,
    };
  }
  if (expectation.target.test(measured).pass) {
    return {
      pass: false,
      asserted: 'baseline',
      message:
        `${expectation.id}: ${expectation.owner}'s target already holds (${expectation.target.description}); ` +
        `remove ${expectation.owner} from PENDING_OWNERS and delete this baseline.`,
    };
  }
  const verdict = expectation.baseline.test(measured);
  return {
    pass: verdict.pass,
    asserted: 'baseline',
    message: `${expectation.id} (baseline for ${expectation.owner}): ${verdict.message}`,
  };
}

function isPending(owner: Owner, pending: ReadonlySet<Owner>): boolean {
  return owner !== 'current' && pending.has(owner);
}

/** The Vitest name of one expectation's test. */
export function expectationTestName(scenarioId: string, expectation: Expectation): string {
  return `${scenarioId} › ${expectation.owner} › ${expectation.id}`;
}

/** Vitest's `it`, injected so this module never loads Vitest itself (`eval.ts` runs under tsx). */
export type RegisterTest = (name: string, body: () => void) => void;

/**
 * Register one Vitest test per expectation, so CI lists each one individually.
 * Call inside a `describe` whose `beforeAll` produces the run.
 *
 * @param it Vitest's `it`.
 * @param scenarioId The scenario's id (the test-name prefix).
 * @param getRun Returns the completed run (populated by `beforeAll`).
 * @param expectations The scenario's expectations.
 */
export function assertExpectations(
  it: RegisterTest,
  scenarioId: string,
  getRun: () => ScenarioRun,
  expectations: readonly Expectation[],
): void {
  for (const expectation of expectations) {
    it(expectationTestName(scenarioId, expectation), () => {
      const verdict = evaluateExpectation(getRun(), expectation);
      if (!verdict.pass) throw new Error(verdict.message);
    });
  }
}

/**
 * The ledger's census: every finding is a reason the catalogue is malformed.
 *
 * - every owner is a declared owner, and every expectation has a note;
 * - expectation ids are unique within a scenario;
 * - `current` never carries a baseline;
 * - a pending owner's expectation always carries one;
 * - a landed owner carries none (a leftover baseline is named);
 * - every pending owner has at least one baseline somewhere;
 * - every scenario has at least one `current` expectation, so none is all-baseline.
 *
 * @param scenarios The catalogue.
 * @param pending The pending-owner set (the real one unless a test substitutes).
 */
export function expectationCensus(
  scenarios: readonly Pick<Scenario, 'id' | 'expectations'>[],
  pending: ReadonlySet<Owner> = PENDING_OWNERS,
): string[] {
  const findings: string[] = [];
  const ownersWithBaseline = new Set<Owner>();
  for (const scenario of scenarios) {
    const ids = new Set<string>();
    if (!scenario.expectations.some((expectation) => expectation.owner === 'current')) {
      findings.push(`${scenario.id}: no "current" expectation — the scenario is all-baseline`);
    }
    for (const expectation of scenario.expectations) {
      const where = `${scenario.id} › ${expectation.id}`;
      if (ids.has(expectation.id)) findings.push(`${where}: duplicate expectation id`);
      ids.add(expectation.id);
      if (!(OWNERS as readonly string[]).includes(expectation.owner)) {
        findings.push(`${where}: undeclared owner "${expectation.owner}"`);
      }
      if (expectation.note.trim().length === 0) findings.push(`${where}: empty note`);
      if (expectation.baseline !== undefined) ownersWithBaseline.add(expectation.owner);
      if (expectation.owner === 'current') {
        if (expectation.baseline !== undefined) {
          findings.push(`${where}: a "current" expectation must not carry a baseline`);
        }
      } else if (pending.has(expectation.owner)) {
        if (expectation.baseline === undefined) {
          findings.push(`${where}: pending owner ${expectation.owner} needs a baseline`);
        }
      } else if (expectation.baseline !== undefined) {
        findings.push(`${where}: ${expectation.owner} has landed; delete this leftover baseline`);
      }
    }
  }
  for (const owner of pending) {
    if (owner !== 'current' && !ownersWithBaseline.has(owner)) {
      findings.push(`pending owner ${owner} has no baseline anywhere in the catalogue`);
    }
  }
  return findings;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function containsShape(value: unknown, shape: unknown): boolean {
  if (Array.isArray(shape)) {
    return (
      Array.isArray(value) &&
      value.length === shape.length &&
      shape.every((item, index) => containsShape(value[index], item))
    );
  }
  if (isPlainObject(shape)) {
    return (
      isPlainObject(value) &&
      Object.entries(shape).every(([key, inner]) => containsShape(value[key], inner))
    );
  }
  return deepEqual(value, shape);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
