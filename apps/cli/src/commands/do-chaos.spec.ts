/**
 * @no-llm Discovery driver chaos + envelope properties (FEAT-020 TASK-006).
 *
 * Extends `do.spec.ts` with: (1) the allowlist envelope property — no
 * navigation outside the allowlist ever reaches the executor, over many
 * randomized host/allowlist combinations; (2) the wall-clock budget
 * dimension (steps/llm-calls are covered in `do.spec.ts`); (3) additional
 * injected-failure chaos scenarios (LLM garbage mid-session, ethics refusal
 * that lets the model recover, a failed step that lets the model recover) —
 * every scenario must terminate cleanly in a valid `DiscoveryOutcome`, never
 * hang or throw.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProposeError } from '@yantra/agent';
import type { Page, RunOutcome } from '@yantra/core';
import type { DiscoveryObservation, DiscoveryProposal, Result } from '@yantra/protocol';
import { err, ok } from '@yantra/protocol';
import * as fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DoRuntime } from './do.js';
import { runDiscoverySession } from './do.js';

let runsDir: string;

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'yantra-do-chaos-'));
});

afterEach(async () => {
  // maxRetries/retryDelay absorb Windows' transient ENOTEMPTY when a nested
  // file handle hasn't released yet under heavy parallel test load.
  await rm(runsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeNavigateProposal(
  host: string,
  overrides: Partial<DiscoveryProposal> = {},
): DiscoveryProposal {
  return {
    rationale: 'go',
    steps: [
      {
        id: 's1',
        type: 'navigate',
        scope: null,
        requires_confirmation: true,
        confirmation_description: null,
        expected_cost: null,
        consequence: null,
        url: { kind: 'literal', value: `https://${host}` },
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

/** Builds a DoRuntime with a controllable clock and canned queues. */
function makeChaosRuntime(opts: {
  readonly proposals: readonly Result<DiscoveryProposal, ProposeError>[];
  readonly runOutcomes?: readonly RunOutcome[];
  readonly clockStepMs?: number;
}): DoRuntime {
  let proposeCall = 0;
  let cycleCall = 0;
  let clockMs = 0;
  const clockStep = opts.clockStepMs ?? 0;

  return {
    env: {},
    stdout: { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream,
    stderr: { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream,
    clock: () => {
      const now = new Date(clockMs);
      clockMs += clockStep;
      return now;
    },
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
        _page,
        cycleResult: { outcome: DiscoveryObservation['step_outcome']; reason: string | null },
      ) =>
        Promise.resolve(
          makeObservation({
            step_outcome: cycleResult.outcome,
            outcome_reason: cycleResult.reason,
          }),
        ) as never,
    ),
    extractor: { extract: () => Promise.resolve(null) },
    gateway: { request: vi.fn() },
    llmClient: { providerId: 'fake', generatePlan: vi.fn(), summarize: vi.fn() },
    runsDir,
  };
}

const budget = { maxSteps: 50, maxLlmCalls: 50, maxWallClockMs: 300_000 };

const hostLabelArb = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((s) => /^[a-z0-9]+$/i.test(s));

describe('@no-llm discovery envelope property: host allowlist', () => {
  it('never dispatches a navigate whose host is outside the allowlist (200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(hostLabelArb, hostLabelArb, async (allowedFragment, proposedFragment) => {
        const allowedHost = `${allowedFragment}.example`;
        const proposedHost = `${proposedFragment}.example`;
        fc.pre(allowedHost !== proposedHost);

        const runtime = makeChaosRuntime({
          proposals: [
            ok(makeNavigateProposal(proposedHost)),
            ok(
              makeNavigateProposal(allowedHost, {
                done: { goal_met: true, summary_md: 's', citations_hint: [] },
              }),
            ),
          ],
        });

        await runDiscoverySession(
          { goal: 'g', dryRun: false, allowHosts: [allowedHost] },
          budget,
          runtime,
        );

        // Every call to runCycle must have been for a step targeting the
        // allowed host — the off-allowlist proposal is never dispatched.
        const runCycleMock = runtime.runCycle as ReturnType<typeof vi.fn>;
        for (const call of runCycleMock.mock.calls) {
          const steps = call[0] as { type: string; url?: { value: string } }[];
          for (const step of steps) {
            if (step.type === 'navigate' && step.url) {
              expect(new URL(step.url.value).host).toBe(allowedHost);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  }, // 200 runs each doing real filesystem I/O (mkdir + discovery.jsonl writes)
  // can exceed the default 5s under heavy parallel CI/test-matrix load.
  20_000);
});

describe('@no-llm discovery chaos', () => {
  it('terminates cleanly (budget_exhausted) when wall-clock elapses mid-loop', async () => {
    const runtime = makeChaosRuntime({
      proposals: [ok(makeNavigateProposal('example.com'))],
      clockStepMs: 50_000,
    });
    const tightWallClock = { maxSteps: 100, maxLlmCalls: 100, maxWallClockMs: 120_000 };

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      tightWallClock,
      runtime,
    );

    expect(result.outcome).toBe('budget_exhausted');
    expect(result.state.cycles.length).toBeGreaterThan(0);
  });

  it('aborts cleanly when the LLM returns garbage mid-session (after prior successful cycles)', async () => {
    const runtime = makeChaosRuntime({
      proposals: [
        ok(makeNavigateProposal('example.com')),
        ok(makeNavigateProposal('example.com', { rationale: 'second cycle' })),
        err({ kind: 'validation_failed', attempts: 3, reasons: ['garbage response'] }),
      ],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.outcome).toBe('aborted');
    expect(result.state.cycles).toHaveLength(2); // the two good cycles are preserved
  });

  it('lets the model recover from an ethics-refused cycle rather than crashing', async () => {
    const runtime = makeChaosRuntime({
      proposals: [
        ok(makeNavigateProposal('example.com')),
        ok(
          makeNavigateProposal('example.com', {
            done: { goal_met: false, summary_md: 'blocked', citations_hint: [] },
          }),
        ),
      ],
      runOutcomes: [{ status: 'failed', failureClass: 'ethics_refused', reportPath: '/tmp/r.md' }],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.state.cycles[0]?.observation?.step_outcome).toBe('ethics_refused');
    expect(result.outcome).toBe('goal_unreachable');
    expect(result.state.cycles).toHaveLength(2);
  });

  it('lets the model recover from a generic failed cycle (e.g. network_error)', async () => {
    const runtime = makeChaosRuntime({
      proposals: [
        ok(makeNavigateProposal('example.com')),
        ok(
          makeNavigateProposal('example.com', {
            done: { goal_met: true, summary_md: 'recovered', citations_hint: [] },
          }),
        ),
      ],
      runOutcomes: [{ status: 'failed', failureClass: 'network_error', reportPath: '/tmp/r.md' }],
    });

    const result = await runDiscoverySession(
      { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
      budget,
      runtime,
    );

    expect(result.state.cycles[0]?.observation?.step_outcome).toBe('failed');
    expect(result.outcome).toBe('goal_met');
  });

  it('every chaos scenario terminates in a valid, defined DiscoveryOutcome (never hangs, never throws)', async () => {
    const scenarios: RunOutcome[] = [
      { status: 'completed', outputKeys: [] },
      { status: 'failed', failureClass: 'ethics_refused', reportPath: '/tmp/r.md' },
      { status: 'failed', failureClass: 'network_error', reportPath: '/tmp/r.md' },
      { status: 'failed', failureClass: 'navigation_timeout', reportPath: '/tmp/r.md' },
      { status: 'handoff', reportPath: '/tmp/r.md' },
    ];

    for (const scenario of scenarios) {
      const runtime = makeChaosRuntime({
        proposals: [ok(makeNavigateProposal('example.com'))],
        runOutcomes: [scenario],
      });
      const tight = { maxSteps: 3, maxLlmCalls: 3, maxWallClockMs: 300_000 };

      const result = await runDiscoverySession(
        { goal: 'g', dryRun: false, allowHosts: ['example.com'] },
        tight,
        runtime,
      );

      expect([
        'goal_met',
        'goal_unreachable',
        'budget_exhausted',
        'user_declined',
        'handoff',
        'aborted',
      ]).toContain(result.outcome);
    }
  });
});
