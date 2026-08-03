// @no-llm
/**
 * `yantra resume` inherits the original run's synthesis strategy
 * (FEAT-FP-001, TASK-009).
 *
 * A resumed run must produce its Brief the way the first attempt did. Silently
 * changing strategy would make a resumed run's output incomparable to the run it
 * continues — and, worse, could acquire a provider session for a run that was
 * started deterministically on purpose.
 */

import type { Logger } from '@yantra/core';
import type { RunManifest } from '@yantra/core/workflow/replay';
import { describe, expect, it, vi } from 'vitest';

import { synthesisForResume } from '../../src/commands/resume.js';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    runId: 'run-001',
    taskId: 'TASK001',
    workflowName: 'quarterly-report',
    workflowVersion: 1,
    params: {},
    startedAt: '2026-07-28T09:00:00.000Z',
    endedAt: '2026-07-28T09:00:30.000Z',
    status: 'failed',
    durationMs: 30_000,
    failureClass: 'locator_not_found',
    profileKind: 'ephemeral',
    cookieProfilePath: null,
    outputBindingNames: [],
    chromeDriftWarning: undefined,
    ...overrides,
  } as RunManifest;
}

describe('@no-llm synthesisForResume', () => {
  it('disables the stage when the original run never synthesized', async () => {
    // Absent `manifest.synthesis` means the first attempt never reached the
    // stage — nothing to inherit.
    await expect(synthesisForResume(manifest(), logger)).resolves.toBeUndefined();
  });

  it('stays deterministic when the original run was deterministic', async () => {
    const wiring = await synthesisForResume(
      manifest({
        synthesis: { strategy: 'deterministic', fallbackUsed: false, briefPath: '/b.json' },
      }),
      logger,
    );

    expect(wiring).toEqual({ llm: null, noLlm: true });
  });

  it('re-offers the model when the original run wanted one and had to fall back', async () => {
    // `fallbackUsed` records intent, not outcome: the workflow declared
    // `synthesis.use_llm` and the model was unreachable that time. Pinning the
    // resume to deterministic would let one transient provider failure quietly
    // rewrite what the workflow produces from then on.
    const wiring = await synthesisForResume(
      manifest({
        synthesis: { strategy: 'deterministic', fallbackUsed: true, briefPath: '/b.json' },
      }),
      logger,
      {},
      { ANTHROPIC_API_KEY: 'fixture' },
    );

    expect(wiring?.noLlm).toBe(false);
    expect(typeof wiring?.llm).toBe('function');
  });

  it('stays deterministic when the run was deterministic by decision, not by failure', async () => {
    // No fallback recorded means nothing was taken away: the workflow never
    // declared `use_llm`, or `--no-llm` vetoed it. Either way the resume must
    // not acquire a provider session the first attempt deliberately lacked.
    const wiring = await synthesisForResume(
      manifest({
        synthesis: { strategy: 'deterministic', fallbackUsed: false, briefPath: null },
      }),
      logger,
    );

    expect(wiring).toEqual({ llm: null, noLlm: true });
  });

  it('re-selects the LLM strategy when the original run used one', async () => {
    const wiring = await synthesisForResume(
      manifest({ synthesis: { strategy: 'llm', fallbackUsed: false, briefPath: '/b.json' } }),
      logger,
      {},
      { ANTHROPIC_API_KEY: 'fixture' },
    );

    expect(wiring?.noLlm).toBe(false);
    expect(typeof wiring?.llm).toBe('function');
  });

  it('builds the inherited LLM port lazily, per run', async () => {
    // The factory shape matters: the session log belongs in the resumed run's
    // directory, which is not known when the wiring is assembled.
    const wiring = await synthesisForResume(
      manifest({ synthesis: { strategy: 'llm', fallbackUsed: false, briefPath: '/b.json' } }),
      logger,
      {},
      { ANTHROPIC_API_KEY: 'fixture' },
    );

    const port = wiring?.llm?.({ runId: 'run-001', runDir: '/runs/run-001' });

    expect(port?.providerId).toContain(':');
  });

  it('records a null briefPath without changing the inherited strategy', async () => {
    // An artifact-write failure on the first attempt still records the strategy.
    const wiring = await synthesisForResume(
      manifest({ synthesis: { strategy: 'llm', fallbackUsed: false, briefPath: null } }),
      logger,
      {},
      { ANTHROPIC_API_KEY: 'fixture' },
    );

    expect(wiring?.noLlm).toBe(false);
  });

  it('honors the shared provider and model flags on resume', async () => {
    const wiring = await synthesisForResume(
      manifest({ synthesis: { strategy: 'llm', fallbackUsed: false, briefPath: '/b.json' } }),
      logger,
      { provider: 'ollama', model: 'llama3.1:8b' },
      { OLLAMA_API_KEY: 'fixture' },
    );

    expect(wiring?.noLlm).toBe(false);
    expect(wiring?.llm?.({ runId: 'run-001', runDir: '/runs/run-001' }).providerId).toContain(
      'ollama',
    );
  });
});
