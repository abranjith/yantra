import { afterEach, describe, expect, it, vi } from 'vitest';

import { failureClassFor } from '../../src/runtime/outcome.js';

import { progressFixture, published, toolFinished } from './progress-test-support.js';

afterEach(() => vi.useRealTimers());

describe('@no-llm FEAT-059 provider thinking limit', () => {
  it('can still publish if the SDK abort settles the turn and then rejects', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const task = progressFixture({
      budgets: { turnTimeoutMs: 10000 },
      script: {
        onRun: async (_prompt, index, session) => {
          if (index === 0) {
            session.emit({ type: 'turn_started', at: new Date().toISOString() });
            await new Promise<void>((resolve) => {
              const abort = session.abort.bind(session);
              session.abort = async () => {
                await abort();
                resolve();
                throw new TypeError('fixture abort finalization');
              };
              started();
            });
          } else {
            await published(session);
            session.emit(toolFinished('result_publish'));
          }
        },
      },
    });
    await ready;
    await vi.advanceTimersByTimeAsync(10001);
    const run = await task;
    expect(run.outcome.kind).toBe('published');
    expect(run.health.progress).toMatchObject({ mode: 'observe', progress_error: true });
    expect(run.provider.sessions).toHaveLength(1);
  });
  it('aborts only the thinking turn and re-prompts the same session, which can publish', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const task = progressFixture({
      budgets: { turnTimeoutMs: 10000 },
      script: {
        onRun: async (prompt, index, session) => {
          if (index === 0) {
            session.emit({ type: 'turn_started', at: new Date().toISOString() });
            await new Promise<void>((resolve) => {
              const abort = session.abort.bind(session);
              session.abort = async () => {
                await abort();
                resolve();
              };
              started();
            });
          } else {
            expect(prompt).toMatch(/^Your last turn exceeded the 10s thinking limit/);
            expect(prompt).toContain('Next:');
            await published(session);
            session.emit(toolFinished('result_publish'));
          }
        },
      },
    });
    await ready;
    await vi.advanceTimersByTimeAsync(10001);
    const run = await task;
    expect(run.provider.sessions).toHaveLength(1);
    expect(run.provider.sessions[0]!.abortCount).toBe(1);
    expect(run.provider.sessions[0]!.runPrompts).toHaveLength(2);
    expect(run.outcome).toMatchObject({ kind: 'published', terminationReason: 'model_finished' });
    expect(run.health.progress).toMatchObject({
      recovery: { triggers: ['turn-timeout'] },
      turns: { turn_limit_aborts: 1 },
    });
  });
  it('uses the same ladder for three long turns and ends with the thinking failure', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const starts: (() => void)[] = [];
    const ready = Array.from(
      { length: 3 },
      () => new Promise<void>((resolve) => starts.push(resolve)),
    );
    const task = progressFixture({
      budgets: { turnTimeoutMs: 10000 },
      script: {
        onRun: async (_p, index, session) => {
          session.emit({ type: 'turn_started', at: new Date().toISOString() });
          await new Promise<void>((resolve) => {
            const abort = session.abort.bind(session);
            session.abort = async () => {
              await abort();
              resolve();
            };
            starts[index]!();
          });
        },
      },
    });
    for (const turn of ready) {
      await turn;
      await vi.advanceTimersByTimeAsync(10001);
    }
    const run = await task;
    expect(run.outcome).toMatchObject({
      kind: 'failed',
      terminationReason: 'turn-timeout',
      error: { code: 'AGENT_TURN_TIMEOUT' },
    });
    expect(failureClassFor(run.outcome)).toBe('budget_exhausted');
    expect(run.events.filter((e) => e.type === 'recovery').map((e) => e.rung)).toEqual([
      'steer',
      'freeze',
      'stop',
    ]);
    expect(run.provider.sessions[0]!.runPrompts).toHaveLength(3);
  });
  it.each(['do', 'research'] as const)(
    'does not limit output generation or observe mode (%s)',
    async (command) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      const task = progressFixture({
        command,
        budgets: { turnTimeoutMs: 10000 },
        script: {
          onRun: async (_p, index, session) => {
            if (index > 0) return;
            session.emit({ type: 'turn_started', at: new Date().toISOString() });
            if (command === 'do')
              session.emit({ type: 'output_started', at: new Date().toISOString() });
            await new Promise<void>((resolve) => {
              finish = resolve;
              started();
            });
          },
        },
      });
      await ready;
      await vi.advanceTimersByTimeAsync(300000);
      finish();
      const run = await task;
      expect(run.provider.sessions[0]!.abortCount).toBe(0);
      expect(run.events.filter((e) => e.type === 'recovery')).toEqual([]);
    },
  );
});
