/**
 * Deterministic gallery data: no clocks, no randomness, so screenshots match
 * their baselines run to run.
 */

export type FixtureOutcome = 'fulfilled' | 'partial' | 'failed' | 'aborted';
export type FixtureMode = 'ask' | 'research' | 'do' | 'run';

export interface FixtureRun {
  readonly id: string;
  readonly goal: string;
  readonly mode: FixtureMode;
  readonly outcome: FixtureOutcome;
  readonly duration: string;
}

const GOALS = [
  'Compare return policies of three outdoor-gear stores',
  'Summarize the release notes for the last two versions',
  'Fill the contact form with the saved profile',
  'Find the cheapest refurbished laptop with 16 GB of memory',
  'Collect the opening hours of the four nearest libraries',
  'Check whether the warranty covers accidental damage',
  'List the sessions on accessibility at the conference',
] as const;

const MODES: readonly FixtureMode[] = ['ask', 'research', 'do', 'run'];
const OUTCOMES: readonly FixtureOutcome[] = [
  'fulfilled',
  'fulfilled',
  'partial',
  'failed',
  'aborted',
];

function pick<T>(values: readonly T[], index: number): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error('fixture lists are never empty');
  }
  return value;
}

/** `count` runs, the same every time. */
export function fixtureRuns(count: number): FixtureRun[] {
  return Array.from({ length: count }, (_, index) => {
    const seconds = 17 + ((index * 37) % 600);
    return {
      id: `run-${String(index + 1).padStart(5, '0')}`,
      goal: pick(GOALS, index),
      mode: pick(MODES, index * 3),
      outcome: pick(OUTCOMES, index * 7),
      duration: `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`,
    };
  });
}
