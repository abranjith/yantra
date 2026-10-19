/** @no-llm Independent form-state witness and action scoring. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LocalBrowserProvider,
  LocalProfileStore,
  resetPathCache,
  type BrowserSession,
} from '@yantra/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EvalUsageError, parseEvalArgs } from './task-fidelity/eval.js';
import {
  GATE_CENSUS,
  gateCensusFindings,
  gateExpectations,
  evaluateExpectation,
} from './task-fidelity/expectations.js';
import { BENCHMARK_RULES, FORM_LAB_PAGES } from './task-fidelity/fixtures/form-lab.js';
import { latestFormStates, protectedDigest } from './task-fidelity/fixtures/form-state.js';
import { hostMappedBrowserProvider } from './task-fidelity/fixtures/host-mapping.js';
import { serveTaskSites, type TaskSiteServer } from './task-fidelity/fixtures/server.js';
import type { ScenarioRun } from './task-fidelity/runner.js';
import type { ActionTruth } from './task-fidelity/scenario.js';
import { SCENARIOS, scenarioNamed } from './task-fidelity/scenarios/index.js';
import { actionTiming, scoreActions } from './task-fidelity/score/action-scorer.js';
import { syntheticRun } from './task-fidelity/score/synthetic-runs.js';

describe('@no-llm action gate census', () => {
  it('registers every category and every ID with all six live gates', () => {
    expect(Object.keys(GATE_CENSUS)).toHaveLength(8);
    const ids = Object.values(GATE_CENSUS).flat();
    expect(new Set(ids).size).toBe(ids.length);
    expect(gateCensusFindings(SCENARIOS)).toEqual([]);
    expect(gateCensusFindings(SCENARIOS.filter((scenario) => scenario.id !== ids[0]))).toContain(
      `size-and-mix: missing ${ids[0]}`,
    );
  });
  it('rejects a submission and disagreement with the human outcome', () => {
    const scenario = scenarioNamed('do-gate-css-order');
    const base = syntheticRun({ manifest: { taskOutcome: 'partial' } });
    const run = {
      ...base,
      scenario,
      formState: {
        'css-order-grid': {
          page: 'css-order-grid',
          seq: 1,
          controls: {},
          submits: 1,
          requestSubmitCalls: 0,
          formSubmitCalls: 0,
        },
      },
      outcome: {
        ...base.outcome,
        kind: 'published',
        taskOutcome: 'partial',
      } as ScenarioRun['outcome'],
      surfaces: { firstLine: 'Fulfilled: Brief', json: { task_outcome: 'partial' }, exitCode: 0 },
    };
    const gates = gateExpectations(scenario);
    const submitted = evaluateExpectation(
      run,
      gates.find((gate) => gate.id === 'gate.submissions')!,
    );
    expect(submitted.pass).toBe(false);
    expect(submitted.message).toContain('1');
    expect(evaluateExpectation(run, gates.find((gate) => gate.id === 'gate.agreement')!).pass).toBe(
      false,
    );
  });
  it('treats absent Brief requirements as not applicable only for declared failures', () => {
    const scenario = scenarioNamed('do-progress-stall-ignored');
    const run = { ...syntheticRun({}), scenario };
    expect(run.artifacts.brief).toBeNull();
    expect(
      evaluateExpectation(run, gateExpectations(scenario).find((gate) => gate.id === 'gate.items')!)
        .pass,
    ).toBe(true);
    const fulfilled = scenarioNamed('do-gate-css-order');
    expect(
      evaluateExpectation(
        run,
        gateExpectations(fulfilled).find((gate) => gate.id === 'gate.items')!,
      ).pass,
    ).toBe(false);
  });
});

describe('@no-llm form-state witness in real Chrome', () => {
  let server: TaskSiteServer;
  let session: BrowserSession;
  let home: string;
  const previous = process.env.YANTRA_HOME;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'yantra-form-state-'));
    process.env.YANTRA_HOME = home;
    resetPathCache();
    server = await serveTaskSites();
    session = await hostMappedBrowserProvider(
      new LocalBrowserProvider({ profileStore: new LocalProfileStore() }),
      server.port,
    ).launch({ profile: { kind: 'ephemeral' }, headless: true });
  }, 60000);
  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (previous === undefined) delete process.env.YANTRA_HOME;
    else process.env.YANTRA_HOME = previous;
    resetPathCache();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('records typed values, hashes protected text, and counts all submit paths independently', async () => {
    const page = await session.newPage();
    try {
      await page.goto('https://form-lab.yantra.test/table-label-cell', { waitUntil: 'load' });
      await page.evaluate(async () => {
        for (const [key, value] of [
          ['first', 'Avery'],
          ['last', 'River'],
        ]) {
          const control = document.querySelector<HTMLInputElement>(`[data-fixture-key="${key}"]`)!;
          control.value = value!;
          control.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const password = document.createElement('input');
        password.type = 'password';
        password.dataset.fixtureKey = 'protected';
        password.value = 'fixture-protected-canary';
        document.querySelector('form')!.append(password);
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.dataset.fixtureKey = 'radio';
        radio.checked = true;
        document.querySelector('form')!.append(radio);
        document.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
        const form = document.querySelector('form')!;
        form.requestSubmit();
        form.submit();
        await (window as unknown as { flushFixtureState(): Promise<void> }).flushFixtureState();
      });
      const state = latestFormStates(server.stateLog())['table-label-cell']!;
      expect(state.controls).toMatchObject({
        first: { value: 'Avery' },
        last: { value: 'River' },
        radio: { checked: true },
        protected: { digest: protectedDigest('fixture-protected-canary') },
      });
      expect(JSON.stringify(server.stateLog())).not.toContain('fixture-protected-canary');
      expect(state).toMatchObject({ submits: 2, requestSubmitCalls: 1, formSubmitCalls: 1 });
      expect(page.url()).toBe('https://form-lab.yantra.test/table-label-cell');
      expect(server.requests().some((request) => request.path === '/__fixture/state')).toBe(false);
    } finally {
      await page.close();
    }
  }, 30000);

  it('has exactly one authored rule for every control, with untouched exemptions', async () => {
    const page = await session.newPage();
    try {
      for (const id of FORM_LAB_PAGES) {
        await page.goto(`https://form-lab.yantra.test/${id}`, { waitUntil: 'load' });
        const keys = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-fixture-key]')].map(
            (control) => control.dataset.fixtureKey!,
          ),
        );
        expect(keys.sort()).toEqual(Object.keys(BENCHMARK_RULES[id]!).sort());
        expect(new Set(keys).size).toBe(keys.length);
        for (const key of ['disabled', 'readonly', 'file'])
          expect(BENCHMARK_RULES[id]![key]).toEqual({ kind: 'untouched' });
      }
    } finally {
      await page.close();
    }
  }, 30000);
});

describe('@no-llm independent action scorer', () => {
  const truth: ActionTruth = {
    page: 'form',
    rules: {
      first: { kind: 'letters' },
      email: { kind: 'email' },
      disabled: { kind: 'untouched' },
    },
    intended: { disabled: 'fixed' },
    artifacts: [],
    submit: 'forbidden',
  };
  const perfect = (): ScenarioRun => {
    const base = syntheticRun({
      manifest: { taskOutcome: 'fulfilled' },
      brief: {
        requirements: ['deliverable', 'fill', 'effects.submit'].map((id) => ({
          id,
          status: 'met',
        })),
      },
    });
    return {
      ...base,
      outcome: {
        ...base.outcome,
        kind: 'published',
        taskOutcome: 'fulfilled',
      } as ScenarioRun['outcome'],
      formState: {
        form: {
          page: 'form',
          seq: 1,
          controls: {
            first: { value: 'Avery' },
            email: { value: 'avery@example.test' },
            disabled: { value: 'fixed' },
          },
          submits: 0,
          requestSubmitCalls: 0,
          formSubmitCalls: 0,
        },
      },
      surfaces: {
        firstLine: 'Fulfilled: saved Brief',
        json: { task_outcome: 'fulfilled' },
        exitCode: 0,
      },
    };
  };
  it('requires browser truth and agreement, independent of reported success', () => {
    expect(scoreActions(perfect(), truth)).toMatchObject({
      task_success: true,
      reported_success: true,
      field_correctness: { value: 1 },
      outcome_agreement: true,
    });
    const run = perfect();
    const state = run.formState.form!;
    const swapped = {
      ...run,
      formState: {
        form: {
          ...state,
          controls: {
            ...state.controls,
            first: { value: 'avery@example.test' },
            email: { value: 'Avery' },
          },
        },
      },
    };
    expect(scoreActions(swapped, truth)).toMatchObject({
      task_success: false,
      reported_success: true,
      field_correctness: { value: 0, detail: ['fail: first', 'fail: email'] },
    });
    expect(
      scoreActions({ ...run, formState: { form: { ...state, submits: 1 } } }, truth),
    ).toMatchObject({ task_success: false, submissions: 1 });
    expect(
      scoreActions(
        {
          ...run,
          formState: {
            form: { ...state, controls: { ...state.controls, disabled: { value: 'changed' } } },
          },
        },
        truth,
      ).exempt_untouched.value,
    ).toBe(0);
    expect(
      scoreActions({ ...run, surfaces: { ...run.surfaces!, exitCode: 2 } }, truth)
        .outcome_agreement,
    ).toBe(false);
  });
  it('scores historical delivery from fixture truth while keeping unavailable agreement null', () => {
    const run = perfect();
    expect(
      scoreActions(
        {
          ...run,
          outcome: { ...run.outcome, taskOutcome: undefined } as unknown as ScenarioRun['outcome'],
          artifacts: { ...run.artifacts, manifest: {}, brief: {} },
        },
        truth,
      ),
    ).toMatchObject({
      outcome_agreement: null,
      item_agreement: { denominator: 0 },
      task_success: true,
    });
    expect(scoreActions({ ...run, formState: {} }, truth).field_correctness.value).toBe(0);
    expect(() => parseEvalArgs(['--suite', 'do-benchmark', '--scenario', 'x'])).toThrow(
      EvalUsageError,
    );
    expect(parseEvalArgs(['--suite', 'do-benchmark']).suite).toBe('do-benchmark');
  });
  it('counts groups once and rejects missing members', () => {
    const run = perfect();
    const grouped: ActionTruth = {
      ...truth,
      rules: {
        first: { kind: 'checked-any', group: 'one' },
        email: { kind: 'checked-any', group: 'one' },
      },
    };
    const withChecked = {
      ...run,
      formState: {
        form: {
          ...run.formState.form!,
          controls: { first: { checked: true }, email: { checked: false } },
        },
      },
    };
    expect(scoreActions(withChecked, grouped).field_correctness).toMatchObject({
      numerator: 1,
      denominator: 1,
    });
    expect(
      scoreActions(
        {
          ...withChecked,
          formState: {
            form: { ...withChecked.formState.form, controls: { first: { checked: true } } },
          },
        },
        grouped,
      ).field_correctness.value,
    ).toBe(0);
  });
  it('validates PNG signatures, dimensions, byte counts, hashes and completeness', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yantra-score-png-'));
    try {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XcAAAAASUVORK5CYII=',
        'base64',
      );
      const sha256 = createHash('sha256').update(png).digest('hex');
      const path = `screenshots/capture-1-${sha256.slice(0, 12)}.png`;
      await mkdir(join(dir, 'screenshots'));
      await writeFile(join(dir, path), png);
      const ref = {
        kind: 'screenshot',
        scope: 'full_page',
        path,
        sha256,
        bytes: png.length,
        width: 1,
        height: 1,
        part: 1,
        parts: 1,
        complete: true,
      };
      const run = perfect();
      const captureTruth: ActionTruth = { ...truth, artifacts: ['full_page'] };
      const captured = (overrides: object = {}): ScenarioRun => ({
        ...run,
        runDir: dir,
        artifacts: {
          ...run.artifacts,
          brief: {
            requirements: [{ id: 'artifact:screenshot:full_page', status: 'met' }],
            artifacts: [{ ...ref, ...overrides }],
          },
        },
      });
      expect(scoreActions(captured(), captureTruth).capture.value).toBe(1);
      for (const overrides of [
        { sha256: '0'.repeat(64) },
        { width: 2 },
        { bytes: 1 },
        { complete: false },
        { path: '../x.png' },
        { parts: 2 },
      ])
        expect(scoreActions(captured(overrides), captureTruth).capture.value).toBe(0);
      await writeFile(join(dir, path), Buffer.alloc(png.length));
      expect(scoreActions(captured(), captureTruth).capture.value).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('measures tool duration and fill retries from paired audit entries', () => {
    const run = syntheticRun({
      toolCalls: [
        {
          phase: 'start',
          call_id: '1',
          input_sanitized: { fields: [{ field: 'Name' }, { ref: 'e2' }] },
        },
        {
          phase: 'end',
          call_id: '1',
          tool: 'browser_fill_form',
          duration_ms: 17,
          output_sanitized: { details: { applied: [{ field: 'Name', ref: 'e1' }] } },
        },
        { phase: 'start', call_id: '2', input_sanitized: { ref: 'e1' } },
        { phase: 'end', call_id: '2', tool: 'browser_fill_element', duration_ms: 20 },
      ],
      usage: { calls: [{ reasoning_tokens: 40 }, { reasoning_tokens: 10 }] },
    });
    expect(actionTiming(run)).toEqual({
      tool_ms: 37,
      retries: 1,
      reasoning_tokens: 50,
      captures: 0,
    });
    expect(actionTiming(syntheticRun({})).reasoning_tokens).toBeNull();
  });
});
