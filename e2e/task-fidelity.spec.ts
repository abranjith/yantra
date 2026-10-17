/**
 * @no-llm task fidelity — deterministic tier (FEAT-049 TASK-007).
 *
 * Each scenario runs once through the production agentic pipeline, driven by a
 * scripted agent against loopback fixture sites, and every expectation it
 * declares becomes its own test, named `<scenario> › <owner> › <id>`. Owners
 * that have not landed are pinned at their observed baselines; the ratchet in
 * `task-fidelity/expectations.ts` fails the suite the moment one of their
 * targets starts holding. See `task-fidelity/README.md`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertRuntimeLinesAreSafe } from '@yantra/test-helpers';
import { afterAll, beforeAll, describe, it } from 'vitest';

import { assertExpectations } from './task-fidelity/expectations.js';
import { runScenario, type ScenarioRun } from './task-fidelity/runner.js';
import { scenariosFor } from './task-fidelity/scenarios/index.js';

/**
 * Per-scenario allowance. A scenario that renders in real Chrome does one or
 * two navigate cycles; full-suite CPU contention roughly doubles each cycle
 * (memory → Testing), so the allowance is sized for contention, not for a lone run.
 */
const SCENARIO_TIMEOUT_MS = 90_000;

describe('@no-llm task fidelity — deterministic tier', () => {
  let runRoot: string | undefined;

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), 'yantra-task-fidelity-tier-'));
  });

  afterAll(async () => {
    if (runRoot !== undefined) await rm(runRoot, { recursive: true, force: true });
  });

  for (const scenario of scenariosFor('deterministic')) {
    describe(`scenario ${scenario.id}`, () => {
      let run: ScenarioRun | undefined;

      beforeAll(async () => {
        if (runRoot === undefined) throw new Error('the tier run root was not created');
        run = await runScenario(scenario, {
          mode: 'deterministic',
          runRoot,
          runtimeLogScanner: assertRuntimeLinesAreSafe,
        });
      }, scenario.timeoutMs ?? SCENARIO_TIMEOUT_MS);

      assertExpectations(
        it,
        scenario.id,
        () => {
          if (run === undefined) throw new Error(`${scenario.id} did not run`);
          return run;
        },
        scenario.expectations,
      );
    });
  }
});
