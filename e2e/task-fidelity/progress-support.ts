import { Writable } from 'node:stream';

import { CLIConnectorIO } from '../../apps/cli/src/connector-io.js';
import { TerminalRenderer } from '../../apps/cli/src/render/terminal.js';

import type { ScriptContext } from './agent/scripted-provider.js';
import type { ScriptStep } from './agent/scripted-provider.js';
import { equals, satisfies, type Expectation } from './expectations.js';
import type { ScenarioRun } from './runner.js';
import type { Scenario } from './scenario.js';
import { crossCuttingExpectations } from './scenarios/common.js';
import { FORM_CONTRACT, FORM_GOAL } from './scenarios/do-form.js';

/** The terminal and JSON connector must agree on every scenario's new progress events. */
function renderingMatches(run: ScenarioRun): boolean {
  const events = run.progress.filter((e) => e.type === 'progress' || e.type === 'recovery');
  for (const json of [false, true]) {
    let stdout = '',
      stderr = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        stdout += String(chunk);
        done();
      },
    });
    const errStream = new Writable({
      write(chunk, _encoding, done) {
        stderr += String(chunk);
        done();
      },
    });
    const connector = new CLIConnectorIO(new TerminalRenderer(), {
      interactive: false,
      renderOpts: { json, noColor: true, debug: false, stream, errStream },
    });
    for (const event of events) connector.emitAgentEvent(event);
    if (json) {
      const records =
        stdout.trim().length === 0
          ? []
          : stdout
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as { kind: string; event: unknown });
      if (
        stderr !== '' ||
        JSON.stringify(records.map((r) => r.event)) !== JSON.stringify(events) ||
        records.some((r) => r.kind !== 'agent_progress')
      )
        return false;
    } else if (
      stdout !== '' ||
      Buffer.from(stderr).includes(Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac])) ||
      [...Buffer.from(stderr)].some((byte) => byte !== 10 && (byte < 32 || byte === 127))
    )
      return false;
  }
  return true;
}

/** Shared synthetic fixture setup; each scenario adds its own behavioral acceptance. */
export function progressScenario(
  id: string,
  script: readonly ScriptStep[],
  rungs: readonly string[],
  extra: readonly Expectation[] = [],
  overrides: Partial<Scenario> = {},
): Scenario {
  return {
    id,
    sites: ['test-form'],
    command: 'do',
    goal: FORM_GOAL,
    contract: FORM_CONTRACT,
    userLocation: null,
    serps: [],
    script,
    tiers: ['deterministic'],
    truth: () => [],
    timeoutMs: 90000,
    expectations: [
      ...crossCuttingExpectations(),
      {
        id: 'recovery-ladder',
        owner: 'FEAT-059',
        measure: (run) => run.progress.filter((e) => e.type === 'recovery').map((e) => e.rung),
        target: equals(rungs),
        note: 'FEAT-059: semantic progress and thinking triggers share one bounded ladder.',
      },
      {
        id: 'json-and-terminal-progress',
        owner: 'FEAT-059',
        measure: renderingMatches,
        target: equals(true),
        note: 'The same progress events render structured JSON and clean stderr.',
      },
      {
        id: 'progress-mode',
        owner: 'FEAT-059',
        measure: (run) =>
          (run.artifacts.runHealth as { progress?: { mode?: string } })?.progress?.mode,
        target: equals(overrides.command === 'research' ? 'observe' : 'enforce'),
        note: 'Only do enforces stalls and the thinking limit.',
      },
      {
        id: 'no-submissions',
        owner: 'FEAT-059',
        measure: (run) => run.requests.filter((r) => r.path.includes('/submit')).length,
        target: equals(0),
        note: 'Recovery never submits the fixture form.',
      },
      ...extra,
    ],
    ...overrides,
  };
}
export const EXTRACT: ScriptStep = { kind: 'call', tool: 'browser_extract', params: {} };
/** Two successful unchanged reads over a fresh 120-second window. */
export const STALL_WINDOW: readonly ScriptStep[] = [
  EXTRACT,
  { kind: 'advance-clock', ms: 125000 },
  EXTRACT,
];
export const RESEARCH_STALL_WINDOW: readonly ScriptStep[] = [
  EXTRACT,
  { kind: 'advance-clock', ms: 125000 },
  EXTRACT,
  EXTRACT,
];
export const failedWith = (code: string): Expectation => ({
  id: 'honest-failure',
  owner: 'FEAT-059',
  measure: (run) => (run.outcome.kind === 'failed' ? run.outcome.error.code : run.outcome.kind),
  target: equals(code),
  note: 'No Brief means an explicit failed outcome with a cause-specific code.',
});
export const partialAfterFreeze: Expectation = {
  id: 'partial-after-freeze',
  owner: 'FEAT-059',
  measure: (run) => ({
    kind: run.outcome.kind,
    reason: run.outcome.terminationReason,
    outcome: run.outcome.kind === 'published' ? run.outcome.taskOutcome : null,
  }),
  target: equals({ kind: 'published', reason: 'stalled', outcome: 'partial' }),
  note: 'A published Brief remains usable and retains its stalled termination reason.',
};
export const risingFills: Expectation = {
  id: 'partial-fills-advance',
  owner: 'FEAT-059',
  measure: (run) =>
    run.progress
      .filter((e) => e.type === 'progress')
      .flatMap((e) => e.items.filter((i) => i.kind === 'fill').map((i) => i.done))
      .filter((n): n is number => n !== null && n > 0)
      .filter((n, i, all) => i === 0 || n !== all[i - 1]),
  target: satisfies(
    'at least two strictly increasing fill counts',
    (value) =>
      Array.isArray(value) &&
      value.length >= 2 &&
      value.every((n, i) => i === 0 || n > value[i - 1]),
  ),
  note: 'A partially failed batch still advances the contract fill item.',
};

/** Click only a ref the most recent observation offered for this named control. */
export function clickObserved(name: string): ScriptStep {
  return {
    kind: 'call',
    tool: 'browser_click',
    params: (ctx: ScriptContext) => {
      const model = ctx.last('browser_observe')?.model as
        | { interactables?: { name?: string; ref?: string }[] }
        | undefined;
      const ref = model?.interactables?.find((c) => c.name === name)?.ref;
      return ref === undefined ? null : { ref };
    },
  };
}
