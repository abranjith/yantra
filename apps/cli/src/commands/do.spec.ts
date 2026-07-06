import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProposeError } from '@yantra/agent';
import type { Page, RunOutcome } from '@yantra/core';
import type { DiscoveryObservation, DiscoveryProposal, Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DoRuntime } from './do.js';
import { runDiscoverySession } from './do.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'yantra-do-'));
});

afterEach(async () => {
  // maxRetries/retryDelay absorb Windows' transient ENOTEMPTY when a nested
  // file handle hasn't released yet under heavy parallel test load.
  await rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeProposal(overrides: Partial<DiscoveryProposal> = {}): DiscoveryProposal {
  return {
    rationale: 'proceed',
    steps: [
      {
        id: 's1',
        type: 'navigate',
        scope: null,
        requires_confirmation: true,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: { kind: 'literal', value: 'https://example.com' },
      },
    ],
    done: null,
    ...overrides,
  };
}

function makeObservation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    url: 'https://example.com',
    title: 'Example',
    page_digest: 'digest',
    interactables: [],
    step_outcome: 'completed',
    outcome_reason: null,
    ...overrides,
  };
}

/** Builds a DoRuntime whose propose()/runCycle()/observe() are canned queues. */
function makeRuntime(opts: {
  readonly proposals: readonly Result<DiscoveryProposal, ProposeError>[];
  readonly runOutcomes?: readonly RunOutcome[];
  readonly observations?: readonly DiscoveryObservation[];
}): DoRuntime {
  let proposeCall = 0;
  let cycleCall = 0;

  const stdout = { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream;
  const stderr = { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream;

  return {
    env: {},
    stdout,
    stderr,
    clock: () => new Date(2026, 0, 1),
    propose: vi.fn(() => {
      const result = opts.proposals[proposeCall] ?? opts.proposals[opts.proposals.length - 1]!;
      proposeCall += 1;
      return Promise.resolve(result);
    }),
    openPage: vi.fn(() => Promise.resolve({} as Page)),
    runCycle: vi.fn(() => {
      const outcome = opts.runOutcomes?.[cycleCall] ??
        opts.runOutcomes?.[opts.runOutcomes.length - 1] ?? {
          status: 'completed' as const,
          outputKeys: [],
        };
      cycleCall += 1;
      return Promise.resolve(outcome);
    }),
    observe: vi.fn(
      (
        _page: unknown,
        cycleResult: { outcome: DiscoveryObservation['step_outcome']; reason: string | null },
      ) => {
        const override =
          opts.observations?.[cycleCall - 1] ?? opts.observations?.[opts.observations.length - 1];
        if (override !== undefined) {
          return Promise.resolve(override) as never;
        }
        // Echo the actual outcome/reason the driver computed so tests can
        // assert on it, rather than masking it behind a fixed canned value.
        return Promise.resolve(
          makeObservation({
            step_outcome: cycleResult.outcome,
            outcome_reason: cycleResult.reason,
          }),
        ) as never;
      },
    ),
    extractor: { extract: () => Promise.resolve(null) },
    gateway: { request: vi.fn() },
    llmClient: { providerId: 'fake', generatePlan: vi.fn(), summarize: vi.fn() },
    runsDir,
  };
}

const budget = { maxSteps: 15, maxLlmCalls: 20, maxWallClockMs: 300_000 };

describe('@no-llm runDiscoverySession', () => {
  it('completes with goal_met after 3 cycles over a fake agent+browser', async () => {
    const runtime = makeRuntime({
      proposals: [
        ok(makeProposal()),
        ok(makeProposal({ rationale: 'click search' })),
        ok(
          makeProposal({
            rationale: 'done',
            done: {
              goal_met: true,
              summary_md: 'Found tickets at [1].',
              citations_hint: ['https://example.com'],
            },
          }),
        ),
      ],
    });

    const result = await runDiscoverySession(
      { goal: 'find tickets', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.outcome).toBe('goal_met');
    expect(result.state.cycles).toHaveLength(3);
    expect(result.brief).not.toBeNull();
    expect(result.brief?.overview).toContain('Found tickets');
  });

  it('terminates with budget_exhausted when max_steps is reached mid-loop', async () => {
    const runtime = makeRuntime({ proposals: [ok(makeProposal())] });
    const tightBudget = { maxSteps: 2, maxLlmCalls: 20, maxWallClockMs: 300_000 };

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      tightBudget,
      runtime,
    );

    expect(result.outcome).toBe('budget_exhausted');
    // Each cycle's single navigate step consumes 1 step; budget exhausts after 2.
    expect(result.state.cycles.length).toBeGreaterThanOrEqual(2);
  });

  it('terminates with budget_exhausted when max_llm_calls is reached', async () => {
    const runtime = makeRuntime({ proposals: [ok(makeProposal())] });
    const tightBudget = { maxSteps: 100, maxLlmCalls: 2, maxWallClockMs: 300_000 };

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      tightBudget,
      runtime,
    );

    expect(result.outcome).toBe('budget_exhausted');
    expect(result.state.cycles).toHaveLength(2);
  });

  it('writes a discovery.jsonl trace with one entry per cycle', async () => {
    const runtime = makeRuntime({
      proposals: [
        ok(makeProposal({ done: { goal_met: true, summary_md: 's', citations_hint: [] } })),
      ],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    const trace = await readFile(join(result.runDir, 'discovery.jsonl'), 'utf8');
    const lines = trace.trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { kind: string };
    expect(entry.kind).toBe('cycle');
  });

  it('returns user_declined and stops immediately when a confirmation is denied', async () => {
    const runtime = makeRuntime({
      proposals: [ok(makeProposal()), ok(makeProposal({ rationale: 'should never be reached' }))],
      runOutcomes: [{ status: 'handoff', reportPath: '/tmp/report.md' }],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.outcome).toBe('user_declined');
    expect(result.state.cycles).toHaveLength(1);
    expect(runtime.propose).toHaveBeenCalledTimes(1);
  });

  it('blocks a navigate outside the allowlist without executing it, and the model can recover', async () => {
    const offSiteNavigate = makeProposal({
      steps: [
        {
          id: 's1',
          type: 'navigate',
          scope: null,
          requires_confirmation: true,
          confirmation_description: null,
          expected_cost: null,
          consequence: null,
          url: { kind: 'literal', value: 'https://evil.example' },
        },
      ],
    });
    const recoveryProposal = makeProposal({
      steps: [
        {
          id: 's1',
          type: 'assert',
          scope: null,
          requires_confirmation: false,
          locator: { kind: 'intent', role: 'heading', name_match: null, near: null },
          condition: { kind: 'visible' },
        },
      ],
      done: { goal_met: false, summary_md: 'Could not proceed safely.', citations_hint: [] },
    });
    const runtime = makeRuntime({
      proposals: [ok(offSiteNavigate), ok(recoveryProposal)],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    // runCycle must never be invoked for the blocked (offsite navigate) cycle,
    // though the second (assert-only) recovery cycle legitimately executes.
    expect(runtime.runCycle).toHaveBeenCalledTimes(1);
    expect(runtime.runCycle).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: 'assert' })]),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(result.outcome).toBe('goal_unreachable');
    expect(result.state.cycles[0]?.observation?.step_outcome).toBe('confirmation_denied');
  });

  it('bootstraps an empty allowlist from the first proposed navigate host', async () => {
    const runtime = makeRuntime({
      proposals: [
        ok(makeProposal({ done: { goal_met: true, summary_md: 's', citations_hint: [] } })),
      ],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: [] },
      budget,
      runtime,
    );

    // The bootstrap cycle still blocks that first cycle (observed as confirmation_denied)
    // per the "nothing is allowed yet" rule, then the allowlist grows for any subsequent cycle.
    expect(result.state.hostAllowlist).toContain('example.com');
  });

  it('dry-run never dispatches a mutating step through runCycle', async () => {
    const runtime = makeRuntime({
      proposals: [
        ok(makeProposal({ done: { goal_met: true, summary_md: 's', citations_hint: [] } })),
      ],
    });

    await runDiscoverySession(
      { goal: 'g', dryRun: true, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(runtime.runCycle).not.toHaveBeenCalled();
  });

  it('dry-run still executes a non-mutating (extract-only) proposal for observation purposes', async () => {
    const runtime = makeRuntime({
      proposals: [
        ok(
          makeProposal({
            steps: [
              {
                id: 's1',
                type: 'extract',
                scope: null,
                requires_confirmation: false,
                locator: { kind: 'intent', role: 'heading', name_match: null, near: null },
                extraction_schema: { type: 'primitive', kind: 'string' },
                capture_as: 'result',
              },
            ],
            done: { goal_met: true, summary_md: 's', citations_hint: [] },
          }),
        ),
      ],
    });

    await runDiscoverySession(
      { goal: 'g', dryRun: true, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(runtime.runCycle).toHaveBeenCalledTimes(1);
  });

  it('aborts when the proposer exhausts its re-prompt budget', async () => {
    const runtime = makeRuntime({
      proposals: [err({ kind: 'validation_failed', attempts: 3, reasons: ['bad'] })],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.outcome).toBe('aborted');
    expect(result.state.cycles).toHaveLength(0);
  });

  it('aborts when the LLM itself is unavailable', async () => {
    const runtime = makeRuntime({
      proposals: [
        err({
          kind: 'llm_error',
          error: { kind: 'llm_unavailable', reason: 'provider_none', hint: 'no provider' },
        }),
      ],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.outcome).toBe('aborted');
  });

  it('produces no Brief when the session never reaches a done claim', async () => {
    const runtime = makeRuntime({ proposals: [ok(makeProposal())] });
    const tightBudget = { maxSteps: 1, maxLlmCalls: 20, maxWallClockMs: 300_000 };

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      tightBudget,
      runtime,
    );

    expect(result.brief).toBeNull();
  });
});
