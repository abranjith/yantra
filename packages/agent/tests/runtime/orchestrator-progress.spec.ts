import { describe, expect, it, vi } from 'vitest';

import {
  exitCodeForAgenticOutcome,
  failureClassFor,
  outcomeFirstLine,
} from '../../src/runtime/outcome.js';
import type { RunServices } from '../../src/runtime/run-services.js';

import { progressFixture, published, toolFinished } from './progress-test-support.js';

describe('@no-llm FEAT-059 semantic stall orchestration', () => {
  it('fails open and records observe mode if progress measurement breaks', async () => {
    const run = await progressFixture({
      onServices: (s) => {
        vi.spyOn(s.progress, 'checkpoint').mockImplementation(() => {
          throw new TypeError('fixture failure');
        });
      },
      script: { eventsOnRun: [toolFinished()] },
    });
    expect(run.health.progress).toMatchObject({ mode: 'observe', progress_error: true });
    expect(run.provider.sessions[0]!.steers).toEqual([]);
    expect(run.outcome).toMatchObject({
      kind: 'failed',
      error: { code: 'AGENT_COMPLETION_MISSING' },
    });
  });
  it('holds an idle steer ahead of the completion nudge', async () => {
    let time = 0;
    const run = await progressFixture({
      budgetNow: () => time,
      script: {
        onRun: async (prompt, index, session) => {
          if (index === 0) {
            session.steer = () => Promise.resolve('idle');
            session.emit(toolFinished());
            time = 125000;
            session.emit(toolFinished());
          } else {
            expect(prompt).toContain('Next:');
            await published(session);
            session.emit(toolFinished('result_publish'));
          }
        },
      },
    });
    expect(run.provider.sessions[0]!.runPrompts).toHaveLength(2);
    expect(run.health.progress).toMatchObject({ recovery: { rungs: ['steer'], steer_idle: 1 } });
    expect(run.outcome.kind).toBe('published');
  });
  it('steers once, freezes, then stops after two refused calls with an honest failure', async () => {
    let time = 0;
    let services: RunServices;
    const run = await progressFixture({
      onServices: (s) => {
        services = s;
      },
      budgetNow: () => time,
      script: {
        onRun: (_p, i, session) => {
          if (i > 0) return;
          for (let n = 0; n < 2; n++) {
            session.emit(toolFinished());
            time += 125000;
            session.emit(toolFinished());
          }
          // Two complete windows fired steer and freeze. These refusals force stop.
          services.budgets.reserveCall('web_fetch');
          session.emit(toolFinished('web_fetch', 'stalled'));
          services.budgets.reserveCall('web_fetch');
          session.emit(toolFinished('web_fetch', 'stalled'));
        },
      },
    });
    expect(run.provider.sessions[0]!.steers).toHaveLength(2);
    expect(run.events.filter((e) => e.type === 'recovery').map((e) => e.rung)).toEqual([
      'steer',
      'freeze',
      'stop',
    ]);
    expect(run.outcome).toMatchObject({
      kind: 'failed',
      terminationReason: 'stalled',
      error: { code: 'AGENT_STALLED' },
    });
    expect(exitCodeForAgenticOutcome(run.outcome)).toBe(2);
    expect(failureClassFor(run.outcome)).toBe('requirements_unmet');
  });
  it('allows publication after the freeze and keeps its reason on the partial Brief', async () => {
    let time = 0;
    const run = await progressFixture({
      budgetNow: () => time,
      script: {
        onRun: async (_p, i, session) => {
          if (i > 0) return;
          for (let n = 0; n < 2; n++) {
            session.emit(toolFinished());
            time += 125000;
            session.emit(toolFinished());
          }
          await published(session);
          session.emit(toolFinished('result_publish'));
        },
      },
    });
    expect(run.outcome.kind).toBe('published');
    expect(run.outcome).toMatchObject({
      kind: 'published',
      taskOutcome: 'partial',
      terminationReason: 'stalled',
    });
    if (run.outcome.kind === 'published')
      expect(outcomeFirstLine(run.outcome)).toContain('(stopped: no progress after recovery)');
  });
  it('protects a non-form read task and observes research without steering', async () => {
    for (const command of ['do', 'research'] as const) {
      let time = 0;
      const run = await progressFixture({
        command,
        budgetNow: () => time,
        script: {
          onRun: (_p, i, session) => {
            if (i > 0) return;
            session.emit(toolFinished());
            time += 125000;
            session.emit(toolFinished('workflow_run'));
          },
        },
      });
      expect(run.provider.sessions[0]!.steers).toHaveLength(command === 'do' ? 1 : 0);
      if (command === 'do')
        expect(run.provider.sessions[0]!.steers[0]).toContain('Next: call result_publish');
      expect(run.health.progress).toMatchObject({ mode: command === 'do' ? 'enforce' : 'observe' });
    }
  });
});
